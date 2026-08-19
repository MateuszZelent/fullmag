use crate::eigen::assembly_scalar::AssembledScalarOperator;
use fullmag_engine::fem::{FemLlgProblem, MeshTopology};
use fullmag_engine::fem_sparse::{lobpcg_generalized_with_progress, CsrMatrix};
use fullmag_engine::periodic::constraints::PeriodicDofMap;
use fullmag_engine::{
    sub, EffectiveFieldObservables, EffectiveFieldTerms, LlgConfig, MaterialParameters,
    TimeIntegrator, Vector3, MU0,
};
use fullmag_ir::{
    EigenDampingPolicyIR, EigenNormalizationIR, EquilibriumSourceIR, FemEigenPlanIR, KSamplingIR,
    OutputIR, SpinWaveBoundaryConditionIR, SpinWaveBoundaryKindIR,
};
use nalgebra::{DMatrix, DVector, SymmetricEigen};
use num_complex::Complex64;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::native_fem;
use crate::types::{
    AuxiliaryArtifact, ExecutedRun, RunError, RunResult, RunStatus, StageFemMeshIdentity,
    StepAction, StepStats,
};
use crate::ExecutionProvenance;

/// DOF threshold above which LOBPCG sparse eigensolver is used instead of
/// the dense O(n³) path. Below this, Cholesky + SymmetricEigen is used.
const SPARSE_EIGEN_THRESHOLD: usize = 3_000;
const FLOQUET_DYNAMIC_DEMAG_UNSUPPORTED: &str = "dynamic demag for Floquet periodic FEM is not implemented yet. Disable demag or use k=0/free boundary.";
const NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND: &str = "slepc_multi_shift_invert_production_cpu_dense";
const NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND: &str = "gpu_modal_device_krylov";
const NATIVE_GPU_K0_KITTEL_SOLVER_KIND: &str = "gpu_dense_k0_macrospin_modal_eigen";
const TANGENT_FRAME_IDENTITY_TOLERANCE: f64 = 1.0e-8;
const MODAL_LINEARIZATION_TERM_EXCHANGE: u32 = 1 << 0;
const MODAL_LINEARIZATION_TERM_FIELD: u32 = 1 << 1;
const MODAL_LINEARIZATION_TERM_DEMAG: u32 = 1 << 4;
pub(crate) const SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON: &str =
    "k0_poisson_airbox_real_fem_assembly_unavailable";
const SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_DETAIL: &str =
    "shared-domain A_qq must be assembled by the native MFEM magnetic operator and bound to a non-null certificate_binding_v6 producer; runner-owned assembly is forbidden";

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativePoissonAirboxK0MetricsInput {
    pub mesh_resolution_m: f64,
    pub airbox_size_m: f64,
    pub magnetic_pair_count: u64,
    pub airbox_pair_count: u64,
    pub effective_magnetisation_a_per_m: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct FemEigenProgress {
    pub phase: &'static str,
    pub phase_index: u32,
    pub phase_count: u32,
    pub percent: f64,
    pub solver_kind: &'static str,
    pub active_nodes: usize,
    pub effective_dof: usize,
    pub requested_modes: usize,
    pub candidate_modes: usize,
    pub computed_modes: usize,
    pub iteration: Option<u32>,
    pub max_iterations: Option<u32>,
    pub residual: Option<f64>,
    pub warning: Option<&'static str>,
}

pub(crate) type FemEigenProgressCallback<'a> =
    dyn FnMut(FemEigenProgress) -> StepAction + Send + 'a;

fn emit_fem_eigen_progress(
    progress: &mut Option<&mut FemEigenProgressCallback<'_>>,
    event: FemEigenProgress,
) -> Result<(), RunError> {
    if let Some(callback) = progress.as_deref_mut() {
        match callback(event) {
            StepAction::Continue => {}
            StepAction::Stop | StepAction::Pause => {
                return Err(RunError {
                    message: "FEM eigen solve was interrupted by runtime control".to_string(),
                });
            }
        }
    }
    Ok(())
}

fn native_modal_progress_event(
    raw: &str,
    solver_kind: &'static str,
    active_nodes: usize,
    effective_dof: usize,
    requested_modes: usize,
) -> Option<FemEigenProgress> {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let object = value.as_object()?;
    let phase = match object
        .get("solver_phase")
        .and_then(serde_json::Value::as_str)
    {
        Some("cancelling_shift_invert") => "cancelling_native_shift_invert",
        Some("solving_shift_invert") => "solving_native_shift_invert",
        Some("solving_contour_interval") => "solving_native_contour_interval",
        _ => "solving_native_shift_invert",
    };
    let as_usize = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0)
    };
    let as_u32 = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0)
    };
    let residual = object
        .get("current_residual_relative_l2")
        .or_else(|| object.get("residual_relative"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite());
    let warning = (phase == "cancelling_native_shift_invert").then_some("cancel_requested");
    Some(FemEigenProgress {
        phase,
        phase_index: 3,
        phase_count: 5,
        percent: 35.0,
        solver_kind,
        active_nodes,
        effective_dof,
        requested_modes,
        candidate_modes: as_usize("candidate_mode_count"),
        computed_modes: as_usize("accepted_mode_count"),
        iteration: Some(as_u32("outer_iteration")),
        max_iterations: object
            .get("max_outer_iterations")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        residual,
        warning,
    })
}

/// Convert a dense nalgebra DMatrix to a sparse CsrMatrix, dropping entries
/// below `drop_tol` in absolute value.
fn dmatrix_to_csr(mat: &DMatrix<f64>, drop_tol: f64) -> CsrMatrix {
    let nrows = mat.nrows();
    let ncols = mat.ncols();
    let mut row_ptr = vec![0usize; nrows + 1];
    let mut col_idx: Vec<u32> = Vec::new();
    let mut values: Vec<f64> = Vec::new();

    for i in 0..nrows {
        for j in 0..ncols {
            let v = mat[(i, j)];
            if v.abs() > drop_tol {
                col_idx.push(j as u32);
                values.push(v);
            }
        }
        row_ptr[i + 1] = col_idx.len();
    }

    CsrMatrix {
        nrows,
        ncols,
        row_ptr,
        col_idx,
        values,
    }
}

pub(crate) fn reject_unsupported_floquet_dynamic_demag(
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    include_demag: bool,
) -> Result<(), RunError> {
    if include_demag && matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        return Err(RunError {
            message: FLOQUET_DYNAMIC_DEMAG_UNSUPPORTED.to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct ReductionMap {
    active_nodes: Vec<usize>,
    node_map: Vec<Option<usize>>,
    node_phases: Vec<Complex64>,
    complex_reduction: bool,
}

#[derive(Debug, Clone)]
struct RealEigenpair {
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    residual_linf: f64,
    mass_norm: f64,
    vector: DVector<f64>,
}

#[derive(Debug, Clone)]
struct ComplexEigenpair {
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    residual_linf: f64,
    mass_norm: f64,
    vector: Vec<Complex64>,
}

#[derive(Debug, Clone)]
struct NativeModalEigenpair {
    /// Stable multiplicity cluster assigned from the accepted spectrum.  The
    /// native ABI exposes a best-effort cluster id, but the runner recomputes
    /// it from the certified frequencies so JSON and typed results cannot
    /// silently advertise every mode as a singleton.
    cluster_id: u64,
    frequency_hz: f64,
    omega_rad_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    residual_linf: f64,
    mass_norm: f64,
    block_residual_q: f64,
    block_residual_phi: f64,
    block_residual_gauge: f64,
    backend_reported_residual: f64,
    vector: Vec<Complex64>,
    /// Native tangent coordinates before Cartesian mode-field projection.
    /// Shared-domain Poisson modes retain the scalar potential payload too;
    /// other modal lanes leave both fields empty.
    q_vector: Vec<Complex64>,
    phi_vector: Vec<Complex64>,
}

struct SharedDomainModeContext<'a> {
    reduced_tangent_mass: &'a DMatrix<f64>,
    active_nodes: &'a [usize],
    magnetic_classes: &'a [u32],
    magnetic_class_count: usize,
}

#[derive(Debug, Clone)]
struct NativeBlochFloquetDensePayload {
    physical_complex_dof: usize,
    stiffness: DMatrix<f64>,
    gyrotropic_row_major: Vec<f64>,
    tangent_mass: DMatrix<f64>,
    physical_mass: Vec<Vec<Complex64>>,
}

#[derive(Debug, Clone)]
struct NativeModalMagneticPencilPayload {
    dependency_digest: String,
    gamma0_m_per_a_s: f64,
}

#[derive(Debug, Clone)]
struct SharedDomainLinearizationState {
    equilibrium_artifact: serde_json::Value,
    linearization_state: serde_json::Value,
    equilibrium_m0: Vec<Vector3>,
    h_eff0: Vec<Vector3>,
    h_demag0: Vec<Vector3>,
    phi0: Vec<f64>,
    equilibrium_id: String,
    mesh_snapshot_id: String,
    material_snapshot_id: String,
    physics_snapshot_id: String,
    boundary_snapshot_id: String,
    producer_run_id: String,
    equilibrium_content_sha256: String,
    demag_model: String,
    m0_norm_tolerance: f64,
    acceptance_certificate: AcceptedEquilibriumCriterion,
    acceptance_certificate_sha256: String,
    equilibrium_artifact_digest: String,
    linearization_state_digest: String,
    periodic_mesh_certificate_digest: String,
    periodic_mesh_certificate_map_binding_digest: String,
}

/// Immutable execution input produced by an accepted FEM relaxation stage and
/// consumed by one following single-k eigen stage.
///
/// This is intentionally distinct from [`AcceptedFemEigenEquilibriumHandoff`],
/// which carries a post-linearization state between samples of one k path.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
struct AcceptedEquilibriumCriterion {
    criterion: String,
    metric_kind: fullmag_ir::StageMetricKind,
    metric_value: f64,
    threshold: f64,
    unit: String,
    status: String,
    converged: bool,
    stop_reason: fullmag_ir::StageStopReason,
}

const ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2: &str = "AcceptedFemRelaxStageHandoff.v2";
#[allow(dead_code)] // Wired by the next migration slice; defined here to freeze the namespace now.
const ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3: &str = "AcceptedFemRelaxStageHandoff.v3";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct AcceptedFemRelaxStageHandoffV2Record {
    schema_version: String,
    source_run_id: String,
    source_stage_id: String,
    source_stage_kind: String,
    stage_fem_mesh_generation_id: String,
    source_mesh_topology_sha256: String,
    node_count: usize,
    indexing_sha256: String,
    part_registry_sha256: String,
    completion_sha256: String,
    completion: fullmag_ir::StageCompletionIR,
    acceptance: AcceptedEquilibriumCriterion,
    equilibrium_content_sha256: String,
    content_sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // Wired by the next migration slice.
struct AcceptedFemRelaxStageHandoffV3HashPreimage {
    schema_version: String,
    legacy_v2_content_sha256: String,
    acceptance_certificate_sha256: String,
    certified_fields_content_sha256: String,
    equilibrium_material_signature: String,
    equilibrium_static_physics_signature: String,
    equilibrium_boundary_signature: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct AcceptedFemRelaxStageHandoffV3Record {
    schema_version: String,
    source_run_id: String,
    source_stage_id: String,
    source_stage_kind: String,
    stage_fem_mesh_generation_id: String,
    source_mesh_topology_sha256: String,
    node_count: usize,
    indexing_sha256: String,
    part_registry_sha256: String,
    completion_sha256: String,
    completion: fullmag_ir::StageCompletionIR,
    acceptance: AcceptedEquilibriumCriterion,
    equilibrium_content_sha256: String,
    legacy_v2_content_sha256: String,
    acceptance_certificate_sha256: String,
    equilibrium_magnetization: Vec<Vector3>,
    certified_fields: crate::types::CertifiedFemEquilibriumFields,
    certified_fields_content_sha256: String,
    equilibrium_material_signature: String,
    equilibrium_static_physics_signature: String,
    equilibrium_boundary_signature: String,
    content_sha256: String,
}

impl AcceptedEquilibriumCriterion {
    fn metric_kind_name(&self) -> &'static str {
        match self.metric_kind {
            fullmag_ir::StageMetricKind::MaxTorqueApm => "max_torque_apm",
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ => "total_energy_plateau_range_j",
            _ => unreachable!("accepted equilibrium uses only torque or energy"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AcceptedFemRelaxStageHandoff {
    schema_version: String,
    source_run_id: String,
    source_stage_id: String,
    source_stage_kind: String,
    stage_fem_mesh_generation_id: String,
    source_mesh_topology_sha256: String,
    node_count: usize,
    indexing_sha256: String,
    part_registry_sha256: String,
    completion_sha256: String,
    completion: fullmag_ir::StageCompletionIR,
    acceptance: AcceptedEquilibriumCriterion,
    equilibrium_content_sha256: String,
    equilibrium_magnetization: Vec<Vector3>,
    certified_fields: crate::types::CertifiedFemEquilibriumFields,
    legacy_v2_content_sha256: String,
    acceptance_certificate_sha256: String,
    equilibrium_material_signature: String,
    equilibrium_static_physics_signature: String,
    equilibrium_boundary_signature: String,
    content_sha256: String,
}

impl AcceptedFemRelaxStageHandoff {
    pub fn from_completed_relax(
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_stage_is_relaxation: bool,
        source_plan: &fullmag_ir::FemPlanIR,
        source_mesh: &crate::types::FemMeshPayload,
        completion: &fullmag_ir::StageCompletionIR,
        equilibrium_magnetization: Vec<Vector3>,
        certified_fields: crate::types::CertifiedFemEquilibriumFields,
    ) -> Result<Self, RunError> {
        if source_run_id.trim().is_empty()
            || source_stage_id.trim().is_empty()
            || source_stage_kind.trim().is_empty()
            || !source_stage_is_relaxation
        {
            return Err(RunError {
                message: "relax_stage_handoff_invalid_source_stage: source run/stage identity must name an executed relaxation stage"
                    .to_string(),
            });
        }
        let acceptance = accepted_equilibrium_criterion(completion)?;
        if equilibrium_magnetization.len() != source_mesh.nodes.len()
            || equilibrium_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_invalid_equilibrium: expected {} finite vectors, got {}",
                    source_mesh.nodes.len(),
                    equilibrium_magnetization.len()
                ),
            });
        }
        validate_certified_equilibrium_fields(&certified_fields, source_mesh.nodes.len())?;
        let source_plan_mesh = crate::types::FemMeshPayload::from(source_plan);
        if crate::types::fem_mesh_topology_fingerprint(&source_plan_mesh)
            != crate::types::fem_mesh_topology_fingerprint(source_mesh)
        {
            return Err(RunError {
                message: "relax_stage_handoff_source_plan_mesh_identity_mismatch".to_string(),
            });
        }
        let source_topology =
            MeshTopology::from_ir(&source_plan.mesh).map_err(|error| RunError {
                message: format!("relax_stage_handoff_source_mesh_topology_invalid: {error}"),
            })?;
        validate_handoff_m0_norms(
            &equilibrium_magnetization,
            &source_topology.magnetic_node_volumes,
        )?;
        let source_signatures =
            crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(
                source_plan,
            )?;

        let source_mesh_topology_sha256 = crate::types::fem_mesh_topology_fingerprint(source_mesh);
        let stage_fem_mesh_generation_id = source_mesh
            .generation_id
            .as_deref()
            .ok_or_else(|| RunError {
                message: "relax_stage_handoff_missing_mesh_generation_id".to_string(),
            })?
            .to_string();
        if stage_fem_mesh_generation_id != source_mesh_topology_sha256
            || !is_sha256_digest(&stage_fem_mesh_generation_id)
        {
            return Err(RunError {
                message: "relax_stage_handoff_mesh_generation_not_full_topology_sha256".to_string(),
            });
        }

        let indexing_sha256 = shared_domain_content_digest(
            "relax_stage_mesh_indexing",
            &serde_json::json!({
                "cells": source_mesh.cells,
                "element_markers": source_mesh.element_markers,
                "facets": source_mesh.facets,
                "boundary_markers": source_mesh.boundary_markers,
                "periodic_boundary_pairs": source_mesh.periodic_boundary_pairs,
                "periodic_node_pairs": source_mesh.periodic_node_pairs,
            }),
        )?;
        let part_registry_sha256 = shared_domain_content_digest(
            "relax_stage_mesh_part_registry",
            &serde_json::json!({
                "object_segments": source_mesh.object_segments,
                "mesh_parts": source_mesh.mesh_parts,
                "domain_mesh_mode": source_mesh.domain_mesh_mode,
                "domain_frame": source_mesh.domain_frame,
            }),
        )?;
        let completion_sha256 = shared_domain_content_digest(
            "relax_stage_completion",
            &serde_json::to_value(completion).map_err(|error| RunError {
                message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
            })?,
        )?;
        let acceptance_certificate_sha256 = shared_domain_content_digest(
            "relax_stage_acceptance_certificate",
            &serde_json::to_value(&acceptance).map_err(|error| RunError {
                message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
            })?,
        )?;
        let equilibrium_content_sha256 = vector_field_content_sha256(&equilibrium_magnetization);
        let node_count = source_mesh.nodes.len();
        let v2_record = AcceptedFemRelaxStageHandoffV2Record {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
            source_run_id: source_run_id.to_string(),
            source_stage_id: source_stage_id.to_string(),
            source_stage_kind: source_stage_kind.to_string(),
            stage_fem_mesh_generation_id: stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: source_mesh_topology_sha256.clone(),
            node_count,
            indexing_sha256: indexing_sha256.clone(),
            part_registry_sha256: part_registry_sha256.clone(),
            completion_sha256: completion_sha256.clone(),
            completion: completion.clone(),
            acceptance: acceptance.clone(),
            equilibrium_content_sha256: equilibrium_content_sha256.clone(),
            content_sha256: String::new(),
        };
        let legacy_v2_content_sha256 = relax_stage_handoff_v2_content_sha256(&v2_record)?;
        let v3_preimage = AcceptedFemRelaxStageHandoffV3HashPreimage {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
            legacy_v2_content_sha256: legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: acceptance_certificate_sha256.clone(),
            certified_fields_content_sha256: certified_fields.content_sha256.clone(),
            equilibrium_material_signature: source_signatures
                .equilibrium_material_signature
                .clone(),
            equilibrium_static_physics_signature: source_signatures
                .equilibrium_static_physics_signature
                .clone(),
            equilibrium_boundary_signature: source_signatures
                .equilibrium_boundary_signature
                .clone(),
        };
        let content_sha256 = relax_stage_handoff_v3_content_sha256(&v3_preimage)?;
        Ok(Self {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
            source_run_id: source_run_id.to_string(),
            source_stage_id: source_stage_id.to_string(),
            source_stage_kind: source_stage_kind.to_string(),
            stage_fem_mesh_generation_id,
            source_mesh_topology_sha256,
            node_count,
            indexing_sha256,
            part_registry_sha256,
            completion_sha256,
            completion: completion.clone(),
            acceptance,
            equilibrium_content_sha256,
            equilibrium_magnetization,
            certified_fields,
            legacy_v2_content_sha256,
            acceptance_certificate_sha256,
            equilibrium_material_signature: source_signatures.equilibrium_material_signature,
            equilibrium_static_physics_signature: source_signatures
                .equilibrium_static_physics_signature,
            equilibrium_boundary_signature: source_signatures.equilibrium_boundary_signature,
            content_sha256,
        })
    }

    fn validate_target_plan(&self, plan: &FemEigenPlanIR) -> Result<(), RunError> {
        if self.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3 {
            return Err(RunError {
                message: "relax_stage_handoff_v3_schema_version_mismatch".to_string(),
            });
        }
        let accepted = accepted_equilibrium_criterion(&self.completion)?;
        if accepted != self.acceptance {
            return Err(RunError {
                message: "relax_stage_handoff_acceptance_certificate_mismatch".to_string(),
            });
        }
        let completion_sha256 = shared_domain_content_digest(
            "relax_stage_completion",
            &serde_json::to_value(&self.completion).map_err(|error| RunError {
                message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
            })?,
        )?;
        if completion_sha256 != self.completion_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_completion_sha256_mismatch".to_string(),
            });
        }
        let acceptance_certificate_sha256 = shared_domain_content_digest(
            "relax_stage_acceptance_certificate",
            &serde_json::to_value(&self.acceptance).map_err(|error| RunError {
                message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
            })?,
        )?;
        if acceptance_certificate_sha256 != self.acceptance_certificate_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_acceptance_certificate_sha256_mismatch".to_string(),
            });
        }
        validate_certified_equilibrium_fields(&self.certified_fields, self.node_count)?;
        let target_signatures =
            crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_eigen_plan(
                plan,
            )?;
        if target_signatures.equilibrium_material_signature != self.equilibrium_material_signature {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_material_signature_mismatch".to_string(),
            });
        }
        if target_signatures.equilibrium_static_physics_signature
            != self.equilibrium_static_physics_signature
        {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_static_physics_signature_mismatch"
                    .to_string(),
            });
        }
        if target_signatures.equilibrium_boundary_signature != self.equilibrium_boundary_signature {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_boundary_signature_mismatch".to_string(),
            });
        }
        if !matches!(plan.equilibrium, EquilibriumSourceIR::RelaxedInitialState) {
            return Err(RunError {
                message: "relax_stage_handoff_requires_relaxed_initial_state_target".to_string(),
            });
        }
        if matches!(plan.k_sampling, Some(KSamplingIR::Path { .. }))
            || !plan.bias_field_samples.is_empty()
        {
            return Err(RunError {
                message: "relax_stage_handoff_requires_single_k_target".to_string(),
            });
        }
        let target_mesh = crate::types::FemMeshPayload::from(plan);
        let target_topology = crate::types::fem_mesh_topology_fingerprint(&target_mesh);
        let target_generation = target_mesh.generation_id.as_deref().unwrap_or_default();
        let target_indexing = shared_domain_content_digest(
            "relax_stage_mesh_indexing",
            &serde_json::json!({
                "cells": target_mesh.cells,
                "element_markers": target_mesh.element_markers,
                "facets": target_mesh.facets,
                "boundary_markers": target_mesh.boundary_markers,
                "periodic_boundary_pairs": target_mesh.periodic_boundary_pairs,
                "periodic_node_pairs": target_mesh.periodic_node_pairs,
            }),
        )?;
        let target_parts = shared_domain_content_digest(
            "relax_stage_mesh_part_registry",
            &serde_json::json!({
                "object_segments": target_mesh.object_segments,
                "mesh_parts": target_mesh.mesh_parts,
                "domain_mesh_mode": target_mesh.domain_mesh_mode,
                "domain_frame": target_mesh.domain_frame,
            }),
        )?;
        if target_generation != self.stage_fem_mesh_generation_id
            || target_topology != self.source_mesh_topology_sha256
            || target_mesh.nodes.len() != self.node_count
            || target_indexing != self.indexing_sha256
            || target_parts != self.part_registry_sha256
        {
            return Err(RunError {
                message: "relax_stage_handoff_mesh_identity_mismatch: generation/topology/node indexing/part registry must match exactly"
                    .to_string(),
            });
        }
        let target_equilibrium_sha256 =
            vector_field_content_sha256(&plan.equilibrium_magnetization);
        let target_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
            message: format!("relax_stage_handoff_target_mesh_topology_invalid: {error}"),
        })?;
        validate_handoff_m0_norms(
            &plan.equilibrium_magnetization,
            &target_topology.magnetic_node_volumes,
        )?;
        if target_equilibrium_sha256 != self.equilibrium_content_sha256
            || plan.equilibrium_magnetization != self.equilibrium_magnetization
        {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_content_mismatch".to_string(),
            });
        }
        let legacy_v2_content_sha256 = relax_stage_handoff_v2_content_sha256(&self.v2_record())?;
        if legacy_v2_content_sha256 != self.legacy_v2_content_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_v2_content_sha256_mismatch".to_string(),
            });
        }
        let recomputed = relax_stage_handoff_v3_content_sha256(&self.v3_hash_preimage())?;
        if recomputed != self.content_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_content_sha256_mismatch".to_string(),
            });
        }
        Ok(())
    }

    fn v3_hash_preimage(&self) -> AcceptedFemRelaxStageHandoffV3HashPreimage {
        AcceptedFemRelaxStageHandoffV3HashPreimage {
            schema_version: self.schema_version.clone(),
            legacy_v2_content_sha256: self.legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: self.acceptance_certificate_sha256.clone(),
            certified_fields_content_sha256: self.certified_fields.content_sha256.clone(),
            equilibrium_material_signature: self.equilibrium_material_signature.clone(),
            equilibrium_static_physics_signature: self.equilibrium_static_physics_signature.clone(),
            equilibrium_boundary_signature: self.equilibrium_boundary_signature.clone(),
        }
    }

    #[cfg(test)]
    fn legacy_v2_provenance_json(&self) -> serde_json::Value {
        serde_json::to_value(self.v2_record()).expect("frozen v2 handoff must serialize")
    }

    fn provenance_json(&self) -> serde_json::Value {
        serde_json::to_value(self.v3_record()).expect("typed v3 handoff must serialize")
    }

    pub fn content_sha256(&self) -> &str {
        &self.content_sha256
    }

    pub fn equilibrium_content_sha256(&self) -> &str {
        &self.equilibrium_content_sha256
    }

    fn acceptance_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.acceptance)
            .expect("accepted equilibrium criterion must serialize")
    }

    fn v2_record(&self) -> AcceptedFemRelaxStageHandoffV2Record {
        AcceptedFemRelaxStageHandoffV2Record {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
            source_run_id: self.source_run_id.clone(),
            source_stage_id: self.source_stage_id.clone(),
            source_stage_kind: self.source_stage_kind.clone(),
            stage_fem_mesh_generation_id: self.stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: self.source_mesh_topology_sha256.clone(),
            node_count: self.node_count,
            indexing_sha256: self.indexing_sha256.clone(),
            part_registry_sha256: self.part_registry_sha256.clone(),
            completion_sha256: self.completion_sha256.clone(),
            completion: self.completion.clone(),
            acceptance: self.acceptance.clone(),
            equilibrium_content_sha256: self.equilibrium_content_sha256.clone(),
            content_sha256: self.legacy_v2_content_sha256.clone(),
        }
    }

    fn v3_record(&self) -> AcceptedFemRelaxStageHandoffV3Record {
        AcceptedFemRelaxStageHandoffV3Record {
            schema_version: self.schema_version.clone(),
            source_run_id: self.source_run_id.clone(),
            source_stage_id: self.source_stage_id.clone(),
            source_stage_kind: self.source_stage_kind.clone(),
            stage_fem_mesh_generation_id: self.stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: self.source_mesh_topology_sha256.clone(),
            node_count: self.node_count,
            indexing_sha256: self.indexing_sha256.clone(),
            part_registry_sha256: self.part_registry_sha256.clone(),
            completion_sha256: self.completion_sha256.clone(),
            completion: self.completion.clone(),
            acceptance: self.acceptance.clone(),
            equilibrium_content_sha256: self.equilibrium_content_sha256.clone(),
            legacy_v2_content_sha256: self.legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: self.acceptance_certificate_sha256.clone(),
            equilibrium_magnetization: self.equilibrium_magnetization.clone(),
            certified_fields: self.certified_fields.clone(),
            certified_fields_content_sha256: self.certified_fields.content_sha256.clone(),
            equilibrium_material_signature: self.equilibrium_material_signature.clone(),
            equilibrium_static_physics_signature: self.equilibrium_static_physics_signature.clone(),
            equilibrium_boundary_signature: self.equilibrium_boundary_signature.clone(),
            content_sha256: self.content_sha256.clone(),
        }
    }
}

fn validate_handoff_m0_norms(
    equilibrium: &[Vector3],
    magnetic_node_volumes: &[f64],
) -> Result<(), RunError> {
    if equilibrium.len() != magnetic_node_volumes.len() {
        return Err(RunError {
            message: format!(
                "relax_stage_handoff_m0_norm_mismatch: topology has {} nodes, equilibrium has {}",
                magnetic_node_volumes.len(),
                equilibrium.len()
            ),
        });
    }
    for (node, magnetization) in equilibrium.iter().enumerate() {
        let norm = magnetization
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt();
        if !norm.is_finite() {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_m0_norm_mismatch: node {node} has non-finite norm"
                ),
            });
        }
        if magnetic_node_volumes[node] <= 0.0 {
            continue;
        }
        let norm_error = (norm - 1.0).abs();
        if norm_error > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_m0_norm_mismatch: node {node} has norm error {norm_error:.3e}"
                ),
            });
        }
    }
    Ok(())
}

fn accepted_equilibrium_criterion(
    completion: &fullmag_ir::StageCompletionIR,
) -> Result<AcceptedEquilibriumCriterion, RunError> {
    let accepted_metric = match (completion.reason, completion.metric) {
        (
            Some(fullmag_ir::StageStopReason::Torque),
            Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
        ) => Some(("torque", fullmag_ir::StageMetricKind::MaxTorqueApm)),
        (
            Some(fullmag_ir::StageStopReason::Energy),
            Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
        ) => Some((
            "energy",
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ,
        )),
        _ => None,
    };
    let accepted_values = match (completion.metric_value, completion.threshold) {
        (Some(value), Some(threshold))
            if value.is_finite()
                && threshold.is_finite()
                && threshold >= 0.0
                && value <= threshold =>
        {
            Some((value, threshold))
        }
        _ => None,
    };
    let (Some((criterion, metric_kind)), Some((metric_value, threshold))) =
        (accepted_metric, accepted_values)
    else {
        return Err(RunError {
            message: "relax_stage_handoff_completion_not_accepted: completion must be completed, converged, use a coherent equilibrium metric, and satisfy its threshold"
                .to_string(),
        });
    };
    if completion.status != "completed" || !completion.converged {
        return Err(RunError {
            message: "relax_stage_handoff_completion_not_accepted: completion must be completed, converged, use a coherent equilibrium metric, and satisfy its threshold"
                .to_string(),
        });
    }
    Ok(AcceptedEquilibriumCriterion {
        criterion: criterion.to_string(),
        metric_kind,
        metric_value,
        threshold,
        unit: metric_kind.unit().to_string(),
        status: completion.status.clone(),
        converged: completion.converged,
        stop_reason: completion
            .reason
            .expect("accepted completion has a stop reason"),
    })
}

fn vector_field_content_sha256(values: &[Vector3]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.m0.v1\0");
    hash.update((values.len() as u64).to_le_bytes());
    for vector in values {
        for value in vector {
            hash.update(value.to_bits().to_le_bytes());
        }
    }
    format!("sha256:{:x}", hash.finalize())
}

fn relax_stage_handoff_v2_content_sha256(
    record: &AcceptedFemRelaxStageHandoffV2Record,
) -> Result<String, RunError> {
    if record.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2 {
        return Err(RunError {
            message: "relax_stage_handoff_v2_schema_version_mismatch".to_string(),
        });
    }
    let completion_json = serde_json::to_vec(&record.completion).map_err(|error| RunError {
        message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
    })?;
    let acceptance_json = serde_json::to_vec(&record.acceptance).map_err(|error| RunError {
        message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
    })?;
    let node_count = (record.node_count as u64).to_le_bytes();
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.v2\0");
    for field in [
        record.source_run_id.as_bytes(),
        record.source_stage_id.as_bytes(),
        record.source_stage_kind.as_bytes(),
        record.stage_fem_mesh_generation_id.as_bytes(),
        record.source_mesh_topology_sha256.as_bytes(),
        node_count.as_slice(),
        record.indexing_sha256.as_bytes(),
        record.part_registry_sha256.as_bytes(),
        record.completion_sha256.as_bytes(),
        completion_json.as_slice(),
        acceptance_json.as_slice(),
        record.equilibrium_content_sha256.as_bytes(),
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[allow(dead_code)] // Wired by the next migration slice.
fn relax_stage_handoff_v3_content_sha256(
    preimage: &AcceptedFemRelaxStageHandoffV3HashPreimage,
) -> Result<String, RunError> {
    if preimage.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3 {
        return Err(RunError {
            message: "relax_stage_handoff_v3_schema_version_mismatch".to_string(),
        });
    }
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.v3\0");
    for field in [
        preimage.legacy_v2_content_sha256.as_bytes(),
        preimage.acceptance_certificate_sha256.as_bytes(),
        preimage.certified_fields_content_sha256.as_bytes(),
        preimage.equilibrium_material_signature.as_bytes(),
        preimage.equilibrium_static_physics_signature.as_bytes(),
        preimage.equilibrium_boundary_signature.as_bytes(),
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

fn validate_certified_equilibrium_fields(
    fields: &crate::types::CertifiedFemEquilibriumFields,
    expected_node_count: usize,
) -> Result<(), RunError> {
    let valid_shape = expected_node_count > 0
        && fields.schema_version == "CertifiedFemEquilibriumFields.v1"
        && fields.h_ex_a_per_m.len() == expected_node_count
        && fields.h_demag_a_per_m.len() == expected_node_count
        && fields.h_ext_a_per_m.len() == expected_node_count
        && fields.h_eff_a_per_m.len() == expected_node_count
        && fields.phi_a.len() == expected_node_count;
    let finite = [
        &fields.h_ex_a_per_m,
        &fields.h_demag_a_per_m,
        &fields.h_ext_a_per_m,
        &fields.h_eff_a_per_m,
    ]
    .into_iter()
    .flat_map(|values| values.iter())
    .flat_map(|value| value.iter())
    .all(|value| value.is_finite())
        && fields.phi_a.iter().all(|value| value.is_finite());
    let digest = crate::types::certified_equilibrium_fields_sha256(fields);
    if !valid_shape || !finite || fields.content_sha256 != digest {
        return Err(RunError {
            message: "relax_stage_handoff_certified_fields_invalid: native static fields must be finite, complete, and digest-bound"
                .to_string(),
        });
    }
    let decomposes_exactly = fields
        .h_ex_a_per_m
        .iter()
        .zip(&fields.h_demag_a_per_m)
        .zip(&fields.h_ext_a_per_m)
        .zip(&fields.h_eff_a_per_m)
        .all(|(((h_ex, h_demag), h_ext), h_eff)| {
            (0..3).all(|component| {
                h_eff[component] == (h_ex[component] + h_demag[component]) + h_ext[component]
            })
        });
    if !decomposes_exactly {
        return Err(RunError {
            message: "relax_stage_handoff_certified_fields_decomposition_mismatch: H_eff must equal H_ex + H_demag + H_ext exactly"
                .to_string(),
        });
    }
    Ok(())
}

fn prepare_single_k_stage_continuation(
    plan: &FemEigenPlanIR,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<FemEigenPlanIR, RunError> {
    handoff.validate_target_plan(plan)?;
    let mut prepared = plan.clone();
    prepared.equilibrium = EquilibriumSourceIR::Provided;
    prepared.equilibrium_magnetization = handoff.equilibrium_magnetization.clone();
    Ok(prepared)
}

fn bind_stage_continuation_artifacts(
    run: &mut ExecutedRun,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<(), RunError> {
    if run.initial_magnetization != handoff.equilibrium_magnetization
        || run.result.final_magnetization != handoff.equilibrium_magnetization
    {
        return Err(RunError {
            message: "relax_stage_handoff_consumed_equilibrium_mismatch".to_string(),
        });
    }
    let equilibrium_source = serde_json::json!({
        "kind": "relaxed_initial_state",
        "handoff": "stage_continuation",
        "content_sha256": handoff.content_sha256,
        "equilibrium_content_sha256": handoff.equilibrium_content_sha256,
    });
    let mut bound_summary = false;
    for artifact in &mut run.auxiliary_artifacts {
        let is_summary = artifact.relative_path == "eigen/metadata/eigen_summary.json";
        let is_spectrum = artifact.relative_path == "eigen/spectrum.json";
        let is_spectrum_bundle = matches!(
            artifact.relative_path.as_str(),
            "eigen/spectrum.v2.json" | "eigen/spectrum.v3.json"
        );
        let is_solver_diagnostics =
            artifact.relative_path == "eigen/diagnostics/solver.v1.json";
        let is_source = artifact.relative_path == "eigen/metadata/equilibrium_source.json";
        let is_mode = artifact.relative_path.starts_with("eigen/modes/")
            && artifact.relative_path.ends_with(".json");
        if !(is_summary
            || is_spectrum
            || is_spectrum_bundle
            || is_solver_diagnostics
            || is_source
            || is_mode)
        {
            continue;
        }
        let mut value: serde_json::Value =
            serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
                message: format!(
                    "relax_stage_handoff_invalid_json_artifact '{}': {error}",
                    artifact.relative_path
                ),
            })?;
        let relaxation_steps = value
            .get("relaxation_steps")
            .and_then(serde_json::Value::as_u64);
        if is_source {
            value = equilibrium_source.clone();
        } else if let Some(object) = value.as_object_mut() {
            if is_summary || is_spectrum {
                if relaxation_steps != Some(0) {
                    return Err(RunError {
                        message: "relax_stage_handoff_second_relaxation_detected".to_string(),
                    });
                }
                object.insert("equilibrium_source".to_string(), equilibrium_source.clone());
                let diagnostics = object
                    .entry("solver_diagnostics")
                    .or_insert_with(|| serde_json::json!({}));
                let diagnostics = diagnostics.as_object_mut().ok_or_else(|| RunError {
                    message: "relax_stage_handoff_solver_diagnostics_not_object".to_string(),
                })?;
                diagnostics.insert(
                    "relax_to_eigen_handoff_sha256".to_string(),
                    serde_json::json!(handoff.content_sha256),
                );
                diagnostics.insert(
                    "source_mesh_topology_sha256".to_string(),
                    serde_json::json!(handoff.source_mesh_topology_sha256),
                );
                diagnostics.insert(
                    "relax_to_eigen_handoff".to_string(),
                    handoff.provenance_json(),
                );
                if let Some(modes) = object
                    .get_mut("modes")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for mode in modes {
                        if let Some(mode) = mode.as_object_mut() {
                            mode.insert(
                                "relax_to_eigen_handoff_sha256".to_string(),
                                serde_json::json!(handoff.content_sha256),
                            );
                            mode.insert(
                                "source_mesh_topology_sha256".to_string(),
                                serde_json::json!(handoff.source_mesh_topology_sha256),
                            );
                        }
                    }
                }
                bound_summary |= is_summary;
            } else if is_mode {
                object.insert(
                    "relax_to_eigen_handoff_sha256".to_string(),
                    serde_json::json!(handoff.content_sha256),
                );
                object.insert(
                    "equilibrium_content_sha256".to_string(),
                    serde_json::json!(handoff.equilibrium_content_sha256),
                );
                object.insert(
                    "source_mesh_topology_sha256".to_string(),
                    serde_json::json!(handoff.source_mesh_topology_sha256),
                );
            } else if is_solver_diagnostics {
                object.insert(
                    "relax_to_eigen_handoff_sha256".to_string(),
                    serde_json::json!(handoff.content_sha256),
                );
                object.insert(
                    "source_mesh_topology_sha256".to_string(),
                    serde_json::json!(handoff.source_mesh_topology_sha256),
                );
                if let Some(samples) = object
                    .get_mut("sample_solver_diagnostics")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for sample in samples {
                        if let Some(diagnostics) = sample
                            .get_mut("diagnostics")
                            .and_then(serde_json::Value::as_object_mut)
                        {
                            diagnostics.insert(
                                "relax_to_eigen_handoff_sha256".to_string(),
                                serde_json::json!(handoff.content_sha256),
                            );
                            diagnostics.insert(
                                "source_mesh_topology_sha256".to_string(),
                                serde_json::json!(handoff.source_mesh_topology_sha256),
                            );
                        }
                    }
                }
            } else if is_spectrum_bundle {
                if let Some(samples) = object
                    .get_mut("samples")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for sample in samples {
                        let Some(modes) = sample
                            .get_mut("modes")
                            .and_then(serde_json::Value::as_array_mut)
                        else {
                            continue;
                        };
                        for mode in modes {
                            if let Some(mode) = mode.as_object_mut() {
                                mode.insert(
                                    "relax_to_eigen_handoff_sha256".to_string(),
                                    serde_json::json!(handoff.content_sha256),
                                );
                                mode.insert(
                                    "source_mesh_topology_sha256".to_string(),
                                    serde_json::json!(handoff.source_mesh_topology_sha256),
                                );
                            }
                        }
                    }
                }
            }
        }
        artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
            message: format!(
                "relax_stage_handoff_artifact_serialization_failed '{}': {error}",
                artifact.relative_path
            ),
        })?;
    }
    if !bound_summary {
        return Err(RunError {
            message: "relax_stage_handoff_missing_eigen_summary".to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct AcceptedFemEigenEquilibriumHandoff {
    stage_mesh_identity: StageFemMeshIdentity,
    source_mesh_topology_sha256: String,
    equilibrium_magnetization: Vec<Vector3>,
    equilibrium_artifact_sha256: String,
    linearization_state_sha256: String,
    content_sha256: String,
}

impl AcceptedFemEigenEquilibriumHandoff {
    pub(crate) fn from_accepted_linearization(
        plan: &FemEigenPlanIR,
        equilibrium_magnetization: Vec<Vector3>,
        equilibrium_artifact_sha256: String,
        linearization_state_sha256: String,
    ) -> Result<Self, RunError> {
        if equilibrium_magnetization.len() != plan.mesh.nodes.len()
            || equilibrium_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_handoff_invalid_equilibrium: expected {} finite vectors, got {}",
                    plan.mesh.nodes.len(),
                    equilibrium_magnetization.len()
                ),
            });
        }
        if !is_sha256_digest(&equilibrium_artifact_sha256)
            || !is_sha256_digest(&linearization_state_sha256)
        {
            return Err(RunError {
                message: "relax_to_eigen_handoff_invalid_digest: equilibrium and linearization identities must be sha256 digests"
                    .to_string(),
            });
        }
        let stage_mesh_identity = StageFemMeshIdentity::from_fem_eigen_plan(plan);
        let source_mesh_topology_sha256 = plan.mesh.topology_fingerprint_v6();
        if stage_mesh_identity.generation_id() != source_mesh_topology_sha256 {
            return Err(RunError {
                message: "relax_to_eigen_stage_mesh_identity_not_full_topology_sha256".to_string(),
            });
        }
        let payload = serde_json::json!({
            "schema_version": "AcceptedFemEigenEquilibriumHandoff.v1",
            "stage_fem_mesh_generation_id": stage_mesh_identity.generation_id(),
            "source_mesh_topology_sha256": &source_mesh_topology_sha256,
            "equilibrium_artifact_sha256": &equilibrium_artifact_sha256,
            "linearization_state_sha256": &linearization_state_sha256,
        });
        let content_sha256 = shared_domain_content_digest("relax_to_eigen_handoff", &payload)?;
        Ok(Self {
            stage_mesh_identity,
            source_mesh_topology_sha256,
            equilibrium_magnetization,
            equilibrium_artifact_sha256,
            linearization_state_sha256,
            content_sha256,
        })
    }

    pub(crate) fn validate_target_plan(&self, plan: &FemEigenPlanIR) -> Result<(), RunError> {
        let target_identity = StageFemMeshIdentity::from_fem_eigen_plan(plan);
        let target_topology_sha256 = plan.mesh.topology_fingerprint_v6();
        if target_identity != self.stage_mesh_identity
            || target_identity.generation_id() != target_topology_sha256
            || target_topology_sha256 != self.source_mesh_topology_sha256
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_mesh_identity_mismatch: source generation/topology='{}'/'{}', target generation/topology='{}'/'{}'",
                    self.stage_mesh_identity.generation_id(),
                    self.source_mesh_topology_sha256,
                    target_identity.generation_id(),
                    target_topology_sha256,
                ),
            });
        }
        Ok(())
    }

    fn validate_consumed_linearization(
        &self,
        plan: &FemEigenPlanIR,
        equilibrium: &[Vector3],
        state: &SharedDomainLinearizationState,
    ) -> Result<(), RunError> {
        self.validate_target_plan(plan)?;
        if equilibrium != self.equilibrium_magnetization {
            return Err(RunError {
                message:
                    "relax_to_eigen_equilibrium_mismatch: provided state differs from accepted relax state"
                        .to_string(),
            });
        }
        if state.equilibrium_artifact_digest != self.equilibrium_artifact_sha256
            || state.linearization_state_digest != self.linearization_state_sha256
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_linearization_mismatch: accepted equilibrium/linearization='{}/{}', consumed='{}/{}'",
                    self.equilibrium_artifact_sha256,
                    self.linearization_state_sha256,
                    state.equilibrium_artifact_digest,
                    state.linearization_state_digest,
                ),
            });
        }
        Ok(())
    }

    pub(crate) fn equilibrium_magnetization(&self) -> &[Vector3] {
        &self.equilibrium_magnetization
    }

    pub(crate) fn content_sha256(&self) -> &str {
        &self.content_sha256
    }

    pub(crate) fn source_mesh_topology_sha256(&self) -> &str {
        &self.source_mesh_topology_sha256
    }

    fn provenance_json(&self) -> serde_json::Value {
        serde_json::json!({
            "schema_version": "AcceptedFemEigenEquilibriumHandoff.v1",
            "stage_fem_mesh_generation_id": self.stage_mesh_identity.generation_id(),
            "source_mesh_topology_sha256": self.source_mesh_topology_sha256,
            "equilibrium_artifact_sha256": self.equilibrium_artifact_sha256,
            "linearization_state_sha256": self.linearization_state_sha256,
            "content_sha256": self.content_sha256,
        })
    }
}

pub(crate) fn accepted_relax_to_eigen_handoff_from_run(
    plan: &FemEigenPlanIR,
    run: &ExecutedRun,
) -> Result<AcceptedFemEigenEquilibriumHandoff, RunError> {
    let summary = run
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_summary".to_string(),
        })
        .and_then(|artifact| {
            serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| RunError {
                message: format!("invalid_relax_to_eigen_handoff_summary: {error}"),
            })
        })?;
    let diagnostics = summary
        .get("solver_diagnostics")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_diagnostics".to_string(),
        })?;
    let handoff_json = diagnostics
        .get("relax_to_eigen_handoff")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_binding".to_string(),
        })?;
    let required = |field: &str| -> Result<String, RunError> {
        handoff_json
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| RunError {
                message: format!("missing_relax_to_eigen_handoff_field: {field}"),
            })
    };
    let source_topology = required("source_mesh_topology_sha256")?;
    let equilibrium_artifact = required("equilibrium_artifact_sha256")?;
    let linearization_state = required("linearization_state_sha256")?;
    let declared_content = required("content_sha256")?;
    let handoff = AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
        plan,
        run.result.final_magnetization.clone(),
        equilibrium_artifact.clone(),
        linearization_state.clone(),
    )?;
    let diagnostic_string =
        |field: &str| diagnostics.get(field).and_then(serde_json::Value::as_str);
    if source_topology != handoff.source_mesh_topology_sha256()
        || declared_content != handoff.content_sha256()
        || diagnostic_string("source_mesh_topology_sha256") != Some(source_topology.as_str())
        || diagnostic_string("relax_to_eigen_handoff_sha256") != Some(declared_content.as_str())
        || diagnostic_string("equilibrium_artifact_sha256") != Some(equilibrium_artifact.as_str())
        || diagnostic_string("linearization_state_sha256") != Some(linearization_state.as_str())
    {
        return Err(RunError {
            message: "relax_to_eigen_handoff_summary_identity_mismatch".to_string(),
        });
    }
    Ok(handoff)
}

#[derive(Debug, Clone)]
struct LoadedEquilibriumArtifactV7 {
    value: serde_json::Value,
    m0: Vec<Vector3>,
    h_eff0: Vec<Vector3>,
    h_demag0: Vec<Vector3>,
    phi0: Vec<f64>,
    equilibrium_id: String,
    producer_run_id: String,
    content_sha256: String,
    mesh_signature: String,
    material_signature: String,
    physics_signature: String,
    boundary_signature: String,
    static_demag_signature: String,
    demag_model: String,
    m0_norm_tolerance: f64,
    phi0_requirement: String,
    periodic_mesh_certificate: serde_json::Value,
    acceptance_certificate: AcceptedEquilibriumCriterion,
    completion_sha256: String,
}

#[derive(Debug, Clone, Copy)]
struct TangentLeakageSummary {
    mean_abs: f64,
    max_abs: f64,
}

// ---------------------------------------------------------------------------
// Legacy GPU dense eigensolver helper (Etap A4).
// The production shared-domain K0 lane below uses the native device-resident
// Krylov solver; this helper remains only for the older non-demag scalar path.
// ---------------------------------------------------------------------------

/// Try to solve K·x = λ·M·x using the GPU (cuSolverDN Dsygvd).
///
/// Returns `Ok(Vec<RealEigenpair>)` on success.
/// Returns `Err(String)` that begins with "UNAVAILABLE:" when the GPU stack is
/// not compiled in, or a descriptive message on any other failure.
/// Callers should fall back to the CPU LAPACK path on error.
fn gpu_solve_real_symmetric_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, String> {
    let n = stiffness.nrows();
    if n == 0 {
        return Err("UNAVAILABLE: empty matrix".to_string());
    }
    // nalgebra DMatrix<f64> is column-major; .as_slice() yields a column-major &[f64].
    let gpu_result =
        native_fem::gpu_eigen_dense_solve(stiffness.as_slice(), mass.as_slice(), n, n)?;

    let mut eigenpairs: Vec<RealEigenpair> = (0..gpu_result.eigenvalues.len())
        .filter_map(|i| {
            let val = gpu_result.eigenvalues[i];
            if !val.is_finite() {
                return None;
            }
            // Column i starts at offset i*n in the column-major eigenvector array.
            let col_slice = &gpu_result.eigenvectors_col_major[i * n..(i + 1) * n];
            let vector = DVector::from_column_slice(col_slice);
            // cuSolverDn Dsygvd returns M-orthonormal vectors; apply plan normalization.
            let normalized = normalize_real_mode(vector, mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, mass, val, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: val,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(mass, &normalized),
                vector: normalized,
            })
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

#[allow(dead_code)]
pub(crate) fn execute_baseline_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(plan, outputs, false, false, None, 0, None, None, None)
}

#[allow(dead_code)]
pub(crate) fn execute_baseline_fem_eigen_with_progress(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        false,
        Some(progress),
        0,
        None,
        None,
        None,
    )
}

pub(crate) fn execute_cpu_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_cpu_fem_eigen_with_handoff(plan, outputs, None)
}

pub(crate) fn execute_cpu_fem_eigen_with_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    if shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    if bias_field_sweep_requested(plan) {
        return execute_bias_field_sweep(plan, outputs, false, None);
    }
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        native_cpu_modal_window_enabled(plan),
        None,
        0,
        None,
        handoff,
        None,
    )
}

pub(crate) fn execute_cpu_fem_eigen_with_progress(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    if shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    if bias_field_sweep_requested(plan) {
        return execute_bias_field_sweep(plan, outputs, false, Some(progress));
    }
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        native_cpu_modal_window_enabled(plan),
        Some(progress),
        0,
        None,
        None,
        None,
    )
}

pub(crate) fn execute_cpu_fem_eigen_with_progress_and_stage_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<ExecutedRun, RunError> {
    let prepared = prepare_single_k_stage_continuation(plan, handoff)?;
    let mut run = execute_fem_eigen_inner(
        &prepared,
        outputs,
        false,
        native_cpu_modal_window_enabled(&prepared),
        Some(progress),
        0,
        None,
        None,
        Some(handoff),
    )?;
    bind_stage_continuation_artifacts(&mut run, handoff)?;
    Ok(run)
}

/// GPU-accelerated FEM eigensolver.
///
/// Shared-domain K0 with dynamic demag is dispatched to the native
/// device-resident Krylov lane.  The legacy non-demag scalar path below still
/// uses the bounded dense cuSolverDN contract.
///
/// When `try_gpu` is true and the GPU is unavailable or fails, returns an
/// error — no silent fallback to CPU.
pub(crate) fn execute_gpu_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: Option<&mut FemEigenProgressCallback<'_>>,
) -> Result<ExecutedRun, RunError> {
    execute_gpu_fem_eigen_with_handoff(plan, outputs, progress, None)
}

pub(crate) fn execute_gpu_fem_eigen_with_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: Option<&mut FemEigenProgressCallback<'_>>,
    handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    if shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    if bias_field_sweep_requested(plan) {
        return execute_bias_field_sweep(plan, outputs, true, progress);
    }
    if native_gpu_k0_kittel_modal_supported(plan) {
        return execute_native_gpu_k0_kittel_modal(plan, outputs, handoff);
    }

    if native_gpu_shared_domain_modal_supported(plan) {
        return execute_fem_eigen_inner(
            plan, outputs, true, true, progress, 0, None, handoff, None,
        );
    }

    if handoff.is_some() {
        return Err(RunError {
            message: "relax_to_eigen_handoff_requires_shared_domain_modal_execution".to_string(),
        });
    }

    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: None,
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        write_partial_artifacts: false,
        completeness_policy: 0,
        eigensolver_family: 0,
        spectral_transform_kind: 0,
        execution_target: native_fem::NativeModalExecutionTarget::Auto,
        cancel_requested: None,
        progress_callback: None,
        tiny_validation_problem: None,
        mfem_operator_problem: None,
        mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem: None,
    })
    .map_err(|message| RunError { message })?;

    Err(RunError {
        message: format!(
            "native FEM modal_eigen production path is unavailable: {} (diagnostics_json={})",
            native_result.error_message, native_result.diagnostics_json
        ),
    })
}

pub(crate) fn execute_gpu_fem_eigen_with_progress_and_stage_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: Option<&mut FemEigenProgressCallback<'_>>,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<ExecutedRun, RunError> {
    let prepared = prepare_single_k_stage_continuation(plan, handoff)?;
    if !native_gpu_shared_domain_modal_supported(&prepared) {
        return Err(RunError {
            message: "relax_to_eigen_handoff_requires_shared_domain_modal_execution".to_string(),
        });
    }
    let mut run = execute_fem_eigen_inner(
        &prepared,
        outputs,
        true,
        true,
        progress,
        0,
        None,
        None,
        Some(handoff),
    )?;
    bind_stage_continuation_artifacts(&mut run, handoff)?;
    Ok(run)
}

fn native_gpu_shared_domain_modal_supported(plan: &FemEigenPlanIR) -> bool {
    plan.precision == fullmag_ir::ExecutionPrecision::Double
        && plan.enable_demag
        && plan.operator.include_demag
        && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        && matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Periodic)
        && is_gamma_k_sampling(plan.k_sampling.as_ref())
        && plan.air_box_config.is_some()
        && native_shared_domain_mesh_metadata_valid(plan)
        && native_shared_domain_magnetic_assembly_available(plan)
        && plan.count > 0
        && plan.count <= 32
        && native_modal_target_frequency_hz(&plan.target) > 0.0
}

fn native_gpu_k0_kittel_modal_supported(plan: &FemEigenPlanIR) -> bool {
    plan.precision == fullmag_ir::ExecutionPrecision::Double
        && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && !plan.operator.include_demag
        && !plan.enable_demag
        && matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        && k_sampling_is_single_k0(plan.k_sampling.as_ref())
}

fn k_sampling_is_single_k0(k_sampling: Option<&KSamplingIR>) -> bool {
    let Some(KSamplingIR::Single { k_vector }) = k_sampling else {
        return false;
    };
    k_vector
        .iter()
        .all(|component| component.is_finite() && component.abs() <= 1.0e-12)
}

fn execute_native_gpu_k0_kittel_modal(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    validate_eigen_equilibrium_certificate(plan, expected_handoff, None)?;
    let initial_magnetization = plan.equilibrium_magnetization.clone();
    let (problem, equilibrium, relaxation_steps, observables, _source_artifact) =
        materialize_equilibrium(plan, &initial_magnetization, None)?;
    let reduction = build_reduction_map(
        &problem.topology,
        &plan.spin_wave_bc,
        plan.k_sampling.as_ref(),
    )?;
    if reduction.active_nodes.is_empty() {
        return Err(RunError {
            message: "FEM GPU K0 Kittel modal solver found no magnetically active nodes"
                .to_string(),
        });
    }
    if reduction.complex_reduction {
        return Err(RunError {
            message: "FEM GPU K0 Kittel modal solver requires k=0 real periodic reduction"
                .to_string(),
        });
    }

    let bases = tangent_bases(&equilibrium);
    let active_nodes = reduction.active_nodes.len();
    let (stiffness_field, mass) = assemble_full_2x2_operator_real(
        plan,
        &problem.topology,
        &reduction,
        &observables,
        &equilibrium,
        &bases,
    );
    let gpu_result = native_fem::gpu_eigen_dense_solve(
        stiffness_field.as_slice(),
        mass.as_slice(),
        stiffness_field.nrows(),
        stiffness_field.nrows(),
    )
    .map_err(|message| RunError {
        message: format!("FEM GPU K0 Kittel modal dense solve failed: {message}"),
    })?;
    let field_eigenvalue = select_k0_kittel_gpu_field_eigenvalue(plan, &gpu_result.eigenvalues)?;
    let omega_rad_s = plan.gyromagnetic_ratio * field_eigenvalue;
    let frequency_hz = omega_rad_s / std::f64::consts::TAU;
    validate_native_modal_lambda_frequency_mapping(omega_rad_s, omega_rad_s, frequency_hz)?;

    let mut mode_vector = k0_macrospin_modal_vector(active_nodes);
    normalize_complex_block_mode(&mut mode_vector, &mass, plan.normalization);
    let tangent_dof = stiffness_field.nrows();
    let stiffness_omega = stiffness_field * plan.gyromagnetic_ratio;
    let gyrotropic_row_major = gyrotropic_matrix_row_major_from_tangent_mass(&mass, active_nodes)?;
    let lambda = Complex64::new(0.0, omega_rad_s);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(
            &stiffness_omega,
            &gyrotropic_row_major,
            lambda,
            &mode_vector,
        );
    let modes = vec![NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real: 0.0,
        eigenvalue_imag: omega_rad_s,
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm: complex_block_mass_norm(&mass, &mode_vector).re,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: 0.0,
        backend_reported_residual: residual_relative_l2,
        vector: mode_vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
    }];
    let solver_diagnostics = native_gpu_k0_kittel_solver_diagnostics(
        plan,
        active_nodes,
        tangent_dof,
        &gpu_result.eigenvalues,
        field_eigenvalue,
        residual_relative_l2,
    );
    let auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        &reduction,
        &bases,
        &modes,
        node_mass_weights_from_tangent_mass(&mass, active_nodes).as_deref(),
        solver_diagnostics,
        relaxation_steps,
        None,
        None,
        0,
    )?;

    let stats = StepStats {
        step: relaxation_steps,
        time: 0.0,
        dt: 0.0,
        e_ex: observables.exchange_energy_joules,
        e_demag: observables.demag_energy_joules,
        e_ext: observables.external_energy_joules,
        e_total: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        ..StepStats::default()
    };

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![stats],
            final_magnetization: equilibrium,
            completion: Some(crate::relaxation::resolve_stage_completion(
                RunStatus::Completed,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: native_gpu_k0_kittel_execution_provenance(plan),
    })
}

fn select_k0_kittel_gpu_field_eigenvalue(
    plan: &FemEigenPlanIR,
    eigenvalues: &[f64],
) -> Result<f64, RunError> {
    let target_field = plan
        .external_field
        .map(norm)
        .filter(|value| value.is_finite() && *value > 0.0);
    let selected = eigenvalues
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .min_by(|left, right| {
            let lhs = target_field
                .map(|target| (*left - target).abs())
                .unwrap_or(*left);
            let rhs = target_field
                .map(|target| (*right - target).abs())
                .unwrap_or(*right);
            lhs.partial_cmp(&rhs).unwrap_or(std::cmp::Ordering::Equal)
        })
        .ok_or_else(|| RunError {
            message:
                "FEM GPU K0 Kittel modal dense solve returned no positive finite field eigenvalue"
                    .to_string(),
        })?;
    Ok(selected)
}

fn k0_macrospin_modal_vector(active_nodes: usize) -> Vec<Complex64> {
    let mut vector = Vec::with_capacity(2 * active_nodes);
    vector.extend((0..active_nodes).map(|_| Complex64::new(1.0, 0.0)));
    vector.extend((0..active_nodes).map(|_| Complex64::new(0.0, -1.0)));
    vector
}

fn native_gpu_k0_kittel_solver_diagnostics(
    plan: &FemEigenPlanIR,
    active_nodes: usize,
    tangent_dof: usize,
    eigenvalues: &[f64],
    selected_field_eigenvalue: f64,
    residual_relative_l2: f64,
) -> serde_json::Value {
    serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_backend": "native_fem_modal_eigen",
        "solver_model": NATIVE_GPU_K0_KITTEL_SOLVER_KIND,
        "solver_kind": NATIVE_GPU_K0_KITTEL_SOLVER_KIND,
        "solver_library": "cusolverdn",
        "resolved_solver_family": "gpu_dense_k0_macrospin",
        "spectral_transform": "dense_generalized",
        "solver_adapter": "cusolverdn_dense_k0_macrospin_modal",
        "execution_lane": "production_gpu",
        "production_solver_available": true,
        "device_residency": "gpu_device_resident",
        "algebraic_form": "k0_macrospin_field_generalized_to_gyrotropic_modal",
        "matrix_equation": "K u = lambda_field M u; lambda_modal = i gamma0 lambda_field",
        "phasor_convention": "exp_i_omega_t",
        "eigenvalue_mapping": "lambda_eq_i_omega",
        "frequency_mapping": "frequency_hz = imag(lambda)/(2*pi)",
        "production_gyrotropic_mapping": true,
        "active_node_count": active_nodes,
        "tangent_dof_count": tangent_dof,
        "requested_mode_count": plan.count,
        "candidate_modes": eigenvalues.len(),
        "selected_field_eigenvalue_A_per_m": selected_field_eigenvalue,
        "selected_frequency_hz": plan.gyromagnetic_ratio * selected_field_eigenvalue / std::f64::consts::TAU,
        "residual_relative_l2": residual_relative_l2,
        "limitations": [
            "k0_only",
            "no_demag",
            "macrospin_larmor_validation_slice",
            "not_nonzero_k_floquet_modal_gpu",
        ],
    })
}

fn native_modal_equilibrium_source_kind(equilibrium: &EquilibriumSourceIR) -> &'static str {
    match equilibrium {
        EquilibriumSourceIR::Provided => "provided",
        EquilibriumSourceIR::RelaxedInitialState => "relax",
        EquilibriumSourceIR::Artifact { .. } => "artifact",
    }
}

fn native_modal_spin_wave_bc_kind(spin_wave_bc: &SpinWaveBoundaryConditionIR) -> &'static str {
    match spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

fn native_modal_damping_policy(damping_policy: EigenDampingPolicyIR) -> &'static str {
    match damping_policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

fn native_modal_target_kind(target: &fullmag_ir::EigenTargetIR) -> &'static str {
    match target {
        fullmag_ir::EigenTargetIR::Lowest => "lowest",
        fullmag_ir::EigenTargetIR::Nearest { .. } => "nearest_frequency",
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => "frequency_window",
    }
}

fn native_modal_target_frequency_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::Lowest => 0.0,
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => *frequency_hz,
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => frequency_min_hz + 0.5 * (frequency_max_hz - frequency_min_hz),
    }
}

fn native_modal_frequency_min_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz, ..
        } => *frequency_min_hz,
        _ => 0.0,
    }
}

fn native_modal_frequency_max_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_max_hz, ..
        } => *frequency_max_hz,
        _ => 0.0,
    }
}

fn native_modal_k_vector(k_sampling: Option<&KSamplingIR>) -> Option<&[f64]> {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => Some(&k_vector[..]),
        _ => None,
    }
}

fn native_modal_floquet_periodic_pairs<'a>(
    plan: &'a FemEigenPlanIR,
    topology: &'a MeshTopology,
) -> Result<Vec<native_fem::NativeModalEigenFloquetPeriodicPair<'a>>, RunError> {
    if !matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        return Ok(Vec::new());
    }
    let Some(KSamplingIR::Single { k_vector }) = plan.k_sampling.as_ref() else {
        return Ok(Vec::new());
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for (pair_id, node_a, node_b) in &topology.periodic_node_pairs {
        if !requested_pair_ids.is_empty()
            && !requested_pair_ids
                .iter()
                .any(|requested| requested == pair_id)
        {
            continue;
        }
        let translation_m = topology
            .periodic_boundary_pairs
            .iter()
            .find(|(boundary_pair_id, _)| boundary_pair_id == pair_id)
            .and_then(|(_, translation)| *translation)
            .ok_or_else(|| RunError {
                message: format!(
                    "Floquet modal periodic pair '{pair_id}' requires mesh.periodic_boundary_pairs translation metadata"
                ),
            })?;
        let phase_rad = match plan.spin_wave_bc.phase_convention() {
            fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR => {
                -(k_vector[0] * translation_m[0]
                    + k_vector[1] * translation_m[1]
                    + k_vector[2] * translation_m[2])
            }
        };
        pairs.push(native_fem::NativeModalEigenFloquetPeriodicPair {
            pair_id: Some(pair_id.as_str()),
            node_a: u64::from(*node_a),
            node_b: u64::from(*node_b),
            translation_m: Some(translation_m),
            phase_rad: Some(phase_rad),
        });
    }
    Ok(pairs)
}

fn native_cpu_modal_window_enabled(plan: &FemEigenPlanIR) -> bool {
    if shared_domain_k0_modal_requested(plan) {
        return native_shared_domain_cpu_modal_supported(plan);
    }
    let base_window_supported =
        matches!(
            plan.target,
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
        ) && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
            && matches!(
                plan.damping_policy,
                fullmag_ir::EigenDampingPolicyIR::Ignore
            );
    base_window_supported
        && ((matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Free
        ) && is_gamma_k_sampling(plan.k_sampling.as_ref()))
            || native_cpu_modal_window_has_bloch_floquet_payload_path(plan))
}

fn shared_domain_k0_modal_requested(plan: &FemEigenPlanIR) -> bool {
    plan.enable_demag
        && plan.operator.include_demag
        && (matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
            || k0_kittel_periodic_airbox_validation_requested(plan))
        && matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        && (matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Periodic)
            || k0_kittel_periodic_airbox_validation_requested(plan))
        && (is_gamma_k_sampling(plan.k_sampling.as_ref())
            || k0_kittel_periodic_airbox_validation_requested(plan))
        && (plan.air_box_config.is_some() || k0_kittel_periodic_airbox_validation_requested(plan))
}

fn native_shared_domain_cpu_modal_supported(plan: &FemEigenPlanIR) -> bool {
    if !shared_domain_k0_modal_requested(plan)
        || plan.count == 0
        || !native_shared_domain_mesh_metadata_valid(plan)
        || !native_shared_domain_magnetic_assembly_available(plan)
    {
        return false;
    }
    if !native_modal_target_frequency_hz(&plan.target).is_finite()
        || native_modal_target_frequency_hz(&plan.target) < 0.0
    {
        return false;
    }
    true
}

fn native_shared_domain_mesh_metadata_valid(plan: &FemEigenPlanIR) -> bool {
    if plan.mesh.periodic_node_pairs.is_empty() || plan.mesh.periodic_boundary_pairs.is_empty() {
        return false;
    }
    let Ok(pair_stats) = periodic_domain_pair_stats(&plan.mesh) else {
        return false;
    };
    pair_stats.magnetic_pair_count > 0
        && pair_stats.airbox_pair_count > 0
        && pa_e4b_airbox_size_m(plan).is_ok()
}

fn native_cpu_modal_window_has_bloch_floquet_payload_path(plan: &FemEigenPlanIR) -> bool {
    if plan.operator.include_demag
        || !matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        || !matches!(
            plan.k_sampling.as_ref(),
            Some(fullmag_ir::KSamplingIR::Single { .. })
                | Some(fullmag_ir::KSamplingIR::Path { .. })
        )
    {
        return false;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return false;
    }
    requested_pair_ids.iter().any(|pair_id| {
        let has_nodes = plan
            .mesh
            .periodic_node_pairs
            .iter()
            .any(|pair| pair.pair_id == *pair_id);
        let has_translation = plan
            .mesh
            .periodic_boundary_pairs
            .iter()
            .any(|pair| pair.pair_id == *pair_id && pair.translation.is_some());
        has_nodes && has_translation
    })
}

fn k0_kittel_periodic_airbox_validation_requested(plan: &FemEigenPlanIR) -> bool {
    plan.k0_kittel_validation
        .as_ref()
        .is_some_and(|validation| {
            validation.kind == "k0_kittel_field_sweep"
                && validation.case_id.as_deref() == Some("K0-3")
                && validation.demag_kind.as_deref() == Some("periodic_airbox_k0")
        })
}

fn bias_field_sweep_requested(plan: &FemEigenPlanIR) -> bool {
    !plan.bias_field_samples.is_empty()
}

fn validate_bias_field_samples(
    plan: &FemEigenPlanIR,
) -> Result<&[fullmag_ir::FemEigenBiasFieldSamplePlanIR], RunError> {
    if plan.bias_field_samples.is_empty() {
        return Err(RunError {
            message: "FEM bias-field sweep requires at least one bias_field_samples entry"
                .to_string(),
        });
    }
    for (position, sample) in plan.bias_field_samples.iter().enumerate() {
        if sample.sample_index as usize != position {
            return Err(RunError {
                message: format!(
                    "FEM bias-field sweep sample index {} is not the declared position {}",
                    sample.sample_index, position
                ),
            });
        }
        if sample.equilibrium_policy == fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach
            && sample.continuation_seed
                == fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium
        {
            return Err(RunError {
                message: format!(
                    concat!(
                        "FEM bias-field sweep sample {} uses ",
                        "continuation_seed=previous_accepted_equilibrium with ",
                        "equilibrium_policy=relax_each; use initial_state",
                    ),
                    sample.sample_index,
                ),
            });
        }
        if sample
            .field_a_per_m
            .iter()
            .any(|component| !component.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "FEM bias-field sweep sample {} requires finite field_a_per_m components",
                    sample.sample_index
                ),
            });
        }
    }
    Ok(&plan.bias_field_samples)
}

fn prepare_bias_field_sample_plan(
    plan: &FemEigenPlanIR,
    sample: &fullmag_ir::FemEigenBiasFieldSamplePlanIR,
    base_initial_magnetization: &[Vector3],
    previous_accepted_magnetization: Option<&[Vector3]>,
) -> Result<FemEigenPlanIR, RunError> {
    let expected_len = plan.mesh.nodes.len();
    if base_initial_magnetization.len() != expected_len {
        return Err(RunError {
            message: format!(
                "FEM bias-field sweep initial magnetization has {} nodes; expected {}",
                base_initial_magnetization.len(),
                expected_len
            ),
        });
    }
    if base_initial_magnetization
        .iter()
        .flatten()
        .any(|component| !component.is_finite())
    {
        return Err(RunError {
            message: "FEM bias-field sweep initial magnetization contains non-finite values"
                .to_string(),
        });
    }

    let starting_magnetization = match sample.equilibrium_policy {
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach => {
            // Each sample is a separate relaxation experiment.  A prior
            // sample must never leak into this policy.
            base_initial_magnetization.to_vec()
        }
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation => {
            if let Some(previous) = previous_accepted_magnetization {
                // Once an accepted sample exists, continuation always uses
                // that accepted state regardless of the bootstrap seed.
                previous.to_vec()
            } else {
                match sample.continuation_seed {
                    // The first sample has no prior accepted state.  The
                    // declared initial state is therefore the deterministic
                    // bootstrap for either valid seed; subsequent samples
                    // use the accepted state above.
                    fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState
                    | fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium => {
                        base_initial_magnetization.to_vec()
                    }
                }
            }
        }
    };
    if starting_magnetization.len() != expected_len {
        return Err(RunError {
            message: format!(
                "FEM bias-field sweep continuation magnetization has {} nodes; expected {}",
                starting_magnetization.len(),
                expected_len
            ),
        });
    }
    if starting_magnetization
        .iter()
        .flatten()
        .any(|component| !component.is_finite())
    {
        return Err(RunError {
            message: "FEM bias-field sweep continuation magnetization contains non-finite values"
                .to_string(),
        });
    }

    let mut sample_plan = plan.clone();
    sample_plan.external_field = Some(sample.field_a_per_m);
    // Both declared policies solve an accepted equilibrium at the current
    // field.  `continuation_seed` selects only the first continuation seed;
    // once a previous accepted state exists it is always the next seed.
    sample_plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
    sample_plan.equilibrium_magnetization = starting_magnetization;
    Ok(sample_plan)
}

fn validate_bias_field_sweep_oracle_contract(plan: &FemEigenPlanIR) -> Result<(), RunError> {
    if plan.k0_kittel_validation.is_some() {
        return Err(RunError {
            message: concat!(
                "bias_field_sweep_kittel_postsolve_oracle_unavailable: physical bias-field ",
                "sweeps cannot claim Kittel validation until a per-sample postsolve adapter ",
                "publishes pass/fail artifacts",
            )
            .to_string(),
        });
    }
    Ok(())
}

fn bias_field_sample_is_complete(status: RunStatus) -> bool {
    status == RunStatus::Completed
}

fn patch_bias_field_sweep_json_artifact(
    run: &mut ExecutedRun,
    relative_path: &str,
    sweep_metadata: &serde_json::Value,
) -> Result<(), RunError> {
    let Some(artifact) = run
        .auxiliary_artifacts
        .iter_mut()
        .find(|artifact| artifact.relative_path == relative_path)
    else {
        return Ok(());
    };
    let mut value = parse_sweep_artifact(artifact, relative_path)?;
    let object = value.as_object_mut().ok_or_else(|| RunError {
        message: format!("bias-field sweep partial artifact {relative_path} must be a JSON object"),
    })?;
    object.insert("status".to_string(), serde_json::json!("interrupted"));
    object.insert("complete".to_string(), serde_json::json!(false));
    object.insert("field_sweep".to_string(), sweep_metadata.clone());
    for key in ["diagnostics", "solver_diagnostics"] {
        if let Some(nested) = object
            .get_mut(key)
            .and_then(serde_json::Value::as_object_mut)
        {
            nested.insert("status".to_string(), serde_json::json!("interrupted"));
            nested.insert("complete".to_string(), serde_json::json!(false));
            nested.insert("field_sweep".to_string(), sweep_metadata.clone());
        }
    }
    artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
        message: format!(
            "failed to serialize bias-field sweep partial artifact {relative_path}: {error}"
        ),
    })?;
    Ok(())
}

fn preserve_interrupted_bias_field_sweep_run(
    mut run: ExecutedRun,
    requested_sample_count: usize,
    completed_sample_count: usize,
    interrupted_sample_index: u32,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
) -> Result<ExecutedRun, RunError> {
    let sweep_metadata = serde_json::json!({
        "kind": "bias_field_sweep",
        "source": "bias_field_samples",
        "status": "interrupted",
        "complete": false,
        "requested_sample_count": requested_sample_count,
        "completed_sample_count": completed_sample_count,
        "interrupted_sample_index": interrupted_sample_index,
        "run_status": run_status_label(run.result.status),
        "subsequent_samples_executed": false,
        "equilibrium_policy": bias_field_equilibrium_policy_label(equilibrium_policy),
        "continuation_seed": bias_field_continuation_seed_label(continuation_seed),
        "continuation_seed_scope": "first_sample_bootstrap",
    });
    let partial = serde_json::json!({
        "schema_version": "fem_k0_modal_partial.v1",
        "status": "interrupted",
        "complete": false,
        "stop_reason": "cancel_requested",
        "field_sweep": sweep_metadata.clone(),
    });
    if let Some(artifact) = run
        .auxiliary_artifacts
        .iter_mut()
        .find(|artifact| artifact.relative_path == "eigen/partial.v1.json")
    {
        let mut value = parse_sweep_artifact(artifact, "eigen/partial.v1.json")?;
        let object = value.as_object_mut().ok_or_else(|| RunError {
            message: "bias-field sweep eigen/partial.v1.json must be a JSON object".to_string(),
        })?;
        object.insert("status".to_string(), serde_json::json!("interrupted"));
        object.insert("complete".to_string(), serde_json::json!(false));
        object.insert("field_sweep".to_string(), sweep_metadata.clone());
        artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
            message: format!("failed to serialize bias-field sweep eigen/partial.v1.json: {error}"),
        })?;
    } else {
        run.auxiliary_artifacts
            .push(json_artifact("eigen/partial.v1.json", &partial)?);
    }
    for path in [
        "eigen/spectrum.v2.json",
        "eigen/spectrum.json",
        "eigen/branches.v2.json",
        "eigen/diagnostics/solver.v1.json",
        "eigen/metadata/eigen_summary.json",
        "frequency_domain/manifest.v1.json",
    ] {
        patch_bias_field_sweep_json_artifact(&mut run, path, &sweep_metadata)?;
    }
    Ok(run)
}

/// Execute every declared physics-owned bias-field sample as an independent
/// solve.  Kittel metadata is rejected here until a real per-sample postsolve
/// adapter can emit expected-vs-solved pass/fail artifacts; it must never be
/// presented as validation merely because it is present in the plan.
fn execute_bias_field_sweep(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    try_gpu: bool,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
) -> Result<ExecutedRun, RunError> {
    execute_bias_field_sweep_with_executor(plan, |sample_plan, sample_position| {
        execute_fem_eigen_inner(
            sample_plan,
            outputs,
            try_gpu,
            true,
            progress.as_deref_mut(),
            sample_position,
            Some(&sample_plan.equilibrium_magnetization),
            None,
            None,
        )
    })
}

fn execute_bias_field_sweep_with_executor<F>(
    plan: &FemEigenPlanIR,
    mut execute_sample: F,
) -> Result<ExecutedRun, RunError>
where
    F: FnMut(&FemEigenPlanIR, usize) -> Result<ExecutedRun, RunError>,
{
    validate_bias_field_sweep_oracle_contract(plan)?;
    let samples = validate_bias_field_samples(plan)?;
    let base_initial_magnetization = plan.equilibrium_magnetization.clone();
    let mut previous_accepted_magnetization: Option<Vec<Vector3>> = None;

    let mut runs = Vec::with_capacity(samples.len());
    for (sample_position, sample) in samples.iter().enumerate() {
        let sample_plan = prepare_bias_field_sample_plan(
            plan,
            sample,
            &base_initial_magnetization,
            previous_accepted_magnetization.as_deref(),
        )?;
        let run = match execute_sample(&sample_plan, sample_position) {
            Ok(run) => run,
            Err(error) if runs.is_empty() => return Err(error),
            Err(error) => {
                return finalize_failed_bias_field_sweep(
                    runs,
                    samples.len(),
                    sample.equilibrium_policy,
                    sample.continuation_seed,
                    error,
                );
            }
        };
        if !bias_field_sample_is_complete(run.result.status) {
            runs.push(run);
            return merge_bias_field_sweep_runs(
                runs,
                samples.len(),
                sample.equilibrium_policy,
                sample.continuation_seed,
            );
        }
        if run.result.final_magnetization.len() != base_initial_magnetization.len()
            || run
                .result
                .final_magnetization
                .iter()
                .flatten()
                .any(|component| !component.is_finite())
        {
            let error = RunError {
                message: format!(
                    "FEM bias-field sweep sample {} did not produce a finite accepted equilibrium",
                    sample.sample_index
                ),
            };
            if runs.is_empty() {
                return Err(error);
            }
            return finalize_failed_bias_field_sweep(
                runs,
                samples.len(),
                sample.equilibrium_policy,
                sample.continuation_seed,
                error,
            );
        }
        previous_accepted_magnetization = Some(run.result.final_magnetization.clone());
        runs.push(run);
    }
    let first_sample = samples.first().ok_or_else(|| RunError {
        message: "bias-field sweep produced no declared samples".to_string(),
    })?;
    merge_bias_field_sweep_runs(
        runs,
        samples.len(),
        first_sample.equilibrium_policy,
        first_sample.continuation_seed,
    )
}

fn native_field_sweep_status(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Completed => "complete",
        RunStatus::Cancelled | RunStatus::Paused => "interrupted",
        RunStatus::Failed => "corrupt",
    }
}

fn native_field_sweep_stop_reason(status: RunStatus) -> Option<&'static str> {
    match status {
        RunStatus::Completed => None,
        RunStatus::Cancelled => Some("cancel_requested"),
        RunStatus::Paused => Some("pause_requested"),
        RunStatus::Failed => Some("failed"),
    }
}

fn required_string_from_json(
    value: &serde_json::Value,
    key: &str,
    context: &str,
) -> Result<String, RunError> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| RunError {
            message: format!("native field sweep requires {context}.{key}"),
        })
}

fn required_sha256_from_json(
    value: &serde_json::Value,
    key: &str,
    context: &str,
) -> Result<String, RunError> {
    let digest = required_string_from_json(value, key, context)?;
    if !is_sha256_digest(&digest) {
        return Err(RunError {
            message: format!("native field sweep requires {context}.{key} as sha256:<hex>"),
        });
    }
    Ok(digest)
}

fn native_field_sweep_execution(diagnostics: &serde_json::Value, key: &str) -> serde_json::Value {
    diagnostics.get(key).cloned().unwrap_or_else(|| {
        serde_json::json!({
            "backend": "fem",
            "device": "not_provided",
            "precision": "not_provided",
            "execution_mode": "modal",
            "engine": "not_provided",
            "implementation_id": null,
            "status": "source_artifact",
            "fallback_used": null,
            "fallback_reason": null,
        })
    })
}

fn native_field_sweep_content_digest(artifact: &serde_json::Value) -> Result<String, RunError> {
    let mut normalized = artifact.clone();
    let object = normalized.as_object_mut().ok_or_else(|| RunError {
        message: "native field sweep artifact must be a JSON object".to_string(),
    })?;
    object.insert(
        "revision".to_string(),
        serde_json::Value::String(String::new()),
    );
    object.insert(
        "content_sha256".to_string(),
        serde_json::Value::String(String::new()),
    );
    let bytes = serde_json::to_vec(&normalized).map_err(|error| RunError {
        message: format!("failed to serialize native field sweep digest envelope: {error}"),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn build_native_field_sweep_artifact(
    spectrum: &serde_json::Value,
    branches: &serde_json::Value,
    diagnostics: &serde_json::Value,
    artifacts: &[AuxiliaryArtifact],
    requested_sample_count: usize,
    sweep_status: RunStatus,
    sweep_stop_reason: Option<&str>,
) -> Result<serde_json::Value, RunError> {
    let spectrum_revision = published_artifact_sha256(artifacts, "eigen/spectrum.v2.json")?;
    let branches_revision = published_artifact_sha256(artifacts, "eigen/branches.v2.json")?;
    let samples = spectrum
        .get("samples")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: "native field sweep requires spectrum.samples".to_string(),
        })?;
    let mut branch_ids_by_mode = BTreeMap::<(u64, u64), u64>::new();
    for branch in branches
        .get("branches")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: "native field sweep requires branches.branches".to_string(),
        })?
    {
        let branch_id = branch
            .get("branch_id")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| RunError {
                message: "native field sweep requires integer branch_id".to_string(),
            })?;
        for point in branch
            .get("points")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RunError {
                message: "native field sweep requires branch points".to_string(),
            })?
        {
            let sample_index = point
                .get("sample_index")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| RunError {
                    message: "native field sweep requires branch point sample_index".to_string(),
                })?;
            let raw_mode_index = point
                .get("raw_mode_index")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| RunError {
                    message: "native field sweep requires branch point raw_mode_index".to_string(),
                })?;
            if branch_ids_by_mode
                .insert((sample_index, raw_mode_index), branch_id)
                .is_some()
            {
                return Err(RunError {
                    message: "native field sweep rejects duplicate branch point mapping"
                        .to_string(),
                });
            }
        }
    }
    let status = native_field_sweep_status(sweep_status);
    let mut output_samples = Vec::with_capacity(samples.len());
    for sample in samples {
        let sample_index = sample
            .get("sample_index")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| RunError {
                message: "native field sweep requires spectrum sample_index".to_string(),
            })?;
        let field = sample
            .get("external_field_a_per_m")
            .and_then(serde_json::Value::as_array)
            .filter(|values| values.len() == 3)
            .ok_or_else(|| RunError {
                message: format!("native field sweep sample {sample_index} has no physical external_field_a_per_m"),
            })?;
        let mut bias_field_a_per_m = [0.0; 3];
        for (component_index, value) in field.iter().enumerate() {
            bias_field_a_per_m[component_index] = value.as_f64().filter(|value| value.is_finite()).ok_or_else(|| RunError {
                message: format!("native field sweep sample {sample_index} has non-finite external_field_a_per_m"),
            })?;
        }
        let topology = serde_json::json!({
            "mesh_id": required_string_from_json(sample, "mesh_id", "spectrum sample")?,
            "topology_revision": required_string_from_json(sample, "topology_revision", "spectrum sample")?,
            "indexing": "sample_index_then_raw_mode_index",
            "sample_axis": "sample_id",
            "mode_axis": "mode_id",
            "node_count": serde_json::Value::Null,
        });
        let sample_id = format!("bias-field-sample-{sample_index:04}");
        let sample_status = sample
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("complete");
        let sample_stop_reason =
            sample
                .get("stop_reason")
                .cloned()
                .unwrap_or(if sample_status == "complete" {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(sweep_stop_reason.unwrap_or("incomplete"))
                });
        let modes = sample
            .get("modes")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RunError {
                message: format!("native field sweep sample {sample_index} requires modes"),
            })?;
        let mut output_modes = Vec::new();
        let mut branch_ids = Vec::new();
        for mode in modes {
            let raw_mode_index = mode
                .get("raw_mode_index")
                .or_else(|| mode.get("index"))
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| RunError {
                    message: format!(
                        "native field sweep sample {sample_index} requires raw_mode_index"
                    ),
                })?;
            let Some(mode_field_id) = mode
                .get("mode_field_id")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let mode_field_resource_key =
                required_string_from_json(mode, "mode_field_resource_key", "spectrum mode")?;
            let branch_id = branch_ids_by_mode
                .get(&(sample_index, raw_mode_index))
                .copied()
                .ok_or_else(|| RunError {
                    message: format!("native field sweep sample {sample_index} mode {raw_mode_index} has no branch mapping"),
                })?;
            if !branch_ids.contains(&branch_id) {
                branch_ids.push(branch_id);
            }
            output_modes.push(serde_json::json!({
                "sample_id": sample_id,
                "mode_id": format!("sample-{sample_index:04}/mode-{raw_mode_index:04}"),
                "raw_mode_index": raw_mode_index,
                "branch_id": branch_id,
                "frequency_hz": mode.get("frequency_hz").cloned().unwrap_or(serde_json::Value::Null),
                "angular_frequency_rad_per_s": mode.get("angular_frequency_rad_per_s").cloned().unwrap_or(serde_json::Value::Null),
                "mode_artifact_path": mode_metadata_path(sample_index as usize, raw_mode_index),
                "mode_field_id": mode_field_id,
                "mode_field_resource_key": mode_field_resource_key,
                "residual_relative_l2": mode.get("residual_relative_l2").cloned().unwrap_or(serde_json::Value::Null),
                "source_revision": spectrum_revision,
                "status": sample_status,
            }));
        }
        let first_mode = modes.first().ok_or_else(|| RunError {
            message: format!("native field sweep sample {sample_index} has no modes"),
        })?;
        output_samples.push(serde_json::json!({
            "sample_id": sample_id,
            "sample_index": sample_index,
            "scan_axis": {
                "kind": "bias_field",
                "coordinate": "external_field_a_per_m",
                "unit": "A/m",
                "display_conversions": [{"name": "mu0_h", "unit": "T", "scale": MU0}],
            },
            "bias_field_a_per_m": bias_field_a_per_m,
            "bias_field_mu0_t": bias_field_a_per_m.map(|value| value * MU0),
            "equilibrium_artifact_sha256": required_sha256_from_json(first_mode, "equilibrium_artifact_sha256", "spectrum mode")?,
            "linearization_state_sha256": required_sha256_from_json(first_mode, "linearization_state_sha256", "spectrum mode")?,
            "operator_input_signature_sha256": required_sha256_from_json(first_mode, "operator_input_signature_sha256", "spectrum mode")?,
            "topology": topology,
            "branch_ids": branch_ids,
            "modes": output_modes,
            "status": sample_status,
            "stop_reason": sample_stop_reason,
        }));
    }
    let topology = output_samples
        .first()
        .and_then(|sample| sample.get("topology"))
        .cloned()
        .unwrap_or_else(|| {
            serde_json::json!({
                "mesh_id": "topology:not_provided",
                "topology_revision": "topology:not_provided",
                "indexing": "sample_index_then_raw_mode_index",
                "sample_axis": "sample_id",
                "mode_axis": "mode_id",
                "node_count": null,
            })
        });
    let completed_sample_count = output_samples
        .iter()
        .filter(|sample| sample.get("status") == Some(&serde_json::json!("complete")))
        .count();
    let complete = sweep_status == RunStatus::Completed
        && completed_sample_count == requested_sample_count
        && output_samples.len() == requested_sample_count;
    let mut artifact = serde_json::json!({
        "schema_version": "eigen/field_sweep.v1",
        "artifact_id": "analysis:eigen:field-sweep",
        "source": {"kind": "modal_eigensolve", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
        "source_revision": spectrum_revision,
        "run_id": "run:current",
        "stage_id": "stage:eigenmodes",
        "scope_id": "scope:bias-field",
        "runtime_id": "runtime:native-fem",
        "revision": "",
        "content_sha256": "",
        "status": status,
        "complete": complete,
        "interrupted": status == "interrupted",
        "stop_reason": if complete { serde_json::Value::Null } else { serde_json::json!(sweep_stop_reason.unwrap_or("incomplete")) },
        "requested_sample_count": requested_sample_count,
        "completed_sample_count": completed_sample_count,
        "scan_axis": {"kind": "bias_field", "coordinate": "external_field_a_per_m", "unit": "A/m", "display_conversions": [{"name": "mu0_h", "unit": "T", "scale": MU0}]},
        "units": {"frequency": "Hz", "angular_frequency": "rad/s", "bias_field": "A/m", "bias_field_display": "mu0 H (T)", "response_amplitude": null, "linewidth": null, "q_factor": null, "covariance": null},
        "topology": topology,
        "requested_execution": native_field_sweep_execution(diagnostics, "requested_execution"),
        "resolved_execution": native_field_sweep_execution(diagnostics, "resolved_execution"),
        "samples": output_samples,
        "cross_artifact_refs": [
            {"relation": "source_spectrum", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
            {"relation": "source_branches", "artifact": "eigen/branches.v2.json", "revision": branches_revision},
        ],
    });
    let content_digest = native_field_sweep_content_digest(&artifact)?;
    let object = artifact.as_object_mut().ok_or_else(|| RunError {
        message: "native field sweep artifact must be a JSON object".to_string(),
    })?;
    object.insert("revision".to_string(), serde_json::json!(content_digest));
    object.insert(
        "content_sha256".to_string(),
        serde_json::json!(content_digest),
    );
    Ok(artifact)
}

fn merge_bias_field_sweep_runs(
    runs: Vec<ExecutedRun>,
    sample_count: usize,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
) -> Result<ExecutedRun, RunError> {
    merge_bias_field_sweep_runs_with_terminal(
        runs,
        sample_count,
        equilibrium_policy,
        continuation_seed,
        None,
    )
}

fn finalize_failed_bias_field_sweep(
    runs: Vec<ExecutedRun>,
    sample_count: usize,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
    error: RunError,
) -> Result<ExecutedRun, RunError> {
    if error.message.trim().is_empty() {
        return Err(error);
    }
    merge_bias_field_sweep_runs_with_terminal(
        runs,
        sample_count,
        equilibrium_policy,
        continuation_seed,
        Some((RunStatus::Failed, error.message)),
    )
}

fn merge_bias_field_sweep_runs_with_terminal(
    runs: Vec<ExecutedRun>,
    sample_count: usize,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
    terminal: Option<(RunStatus, String)>,
) -> Result<ExecutedRun, RunError> {
    let mut runs = runs.into_iter();
    let first_run = runs.next().ok_or_else(|| RunError {
        message: "bias-field sweep produced no sample runs".to_string(),
    })?;
    let mut all_runs = Vec::with_capacity(sample_count.max(1));
    all_runs.push(first_run);
    all_runs.extend(runs);
    let inferred_sweep_status = all_runs
        .iter()
        .find_map(|run| (run.result.status != RunStatus::Completed).then_some(run.result.status))
        .unwrap_or(RunStatus::Completed);
    let sweep_status = terminal
        .as_ref()
        .map(|(status, _)| *status)
        .unwrap_or(inferred_sweep_status);
    let sweep_complete = sweep_status == RunStatus::Completed
        && all_runs
            .iter()
            .all(|run| run.result.status == RunStatus::Completed);
    let sweep_status_label = run_status_label(sweep_status);
    let artifact_status_label = native_field_sweep_status(sweep_status);
    let sweep_stop_reason = terminal
        .as_ref()
        .map(|(_, stop_reason)| stop_reason.as_str())
        .or_else(|| native_field_sweep_stop_reason(sweep_status));
    let completed_sample_count = all_runs
        .iter()
        .filter(|run| run.result.status == RunStatus::Completed)
        .count();

    let mut spectrum_samples = Vec::new();
    let mut branch_points = BTreeMap::<u64, Vec<serde_json::Value>>::new();
    let mut branch_templates = BTreeMap::<u64, serde_json::Value>::new();
    let mut summary_modes = Vec::new();
    let mut sample_solver_diagnostics = Vec::new();
    let mut summary_template = None;
    let mut solver_diagnostics_template = None;
    let mut manifest_template = None;
    let mut artifacts = Vec::new();
    let mut artifact_paths = std::collections::BTreeSet::new();

    for run in &all_runs {
        let include_completed_sample = run.result.status == RunStatus::Completed;
        for artifact in &run.auxiliary_artifacts {
            match artifact.relative_path.as_str() {
                "eigen/spectrum.v2.json" => {
                    let spectrum = parse_sweep_artifact(artifact, "eigen/spectrum.v2.json")?;
                    if include_completed_sample {
                        if let Some(samples) = spectrum.get("samples").and_then(|v| v.as_array()) {
                            spectrum_samples.extend(samples.iter().cloned().map(|mut sample| {
                                if let Some(object) = sample.as_object_mut() {
                                    object.insert(
                                        "status".to_string(),
                                        serde_json::json!("complete"),
                                    );
                                    object
                                        .insert("stop_reason".to_string(), serde_json::Value::Null);
                                }
                                sample
                            }));
                        }
                    }
                }
                "eigen/branches.v2.json" => {
                    let branches = parse_sweep_artifact(artifact, "eigen/branches.v2.json")?;
                    if include_completed_sample {
                        if let Some(entries) = branches.get("branches").and_then(|v| v.as_array()) {
                            for branch in entries {
                                let branch_id = branch
                                    .get("branch_id")
                                    .and_then(serde_json::Value::as_u64)
                                    .unwrap_or(0);
                                branch_templates
                                    .entry(branch_id)
                                    .or_insert_with(|| branch.clone());
                                if let Some(points) =
                                    branch.get("points").and_then(|v| v.as_array())
                                {
                                    branch_points
                                        .entry(branch_id)
                                        .or_default()
                                        .extend(points.iter().cloned());
                                }
                            }
                        }
                    }
                }
                "eigen/metadata/eigen_summary.json" => {
                    let summary =
                        parse_sweep_artifact(artifact, "eigen/metadata/eigen_summary.json")?;
                    if summary_template.is_none() {
                        summary_template = Some(summary.clone());
                    }
                    if include_completed_sample {
                        if let Some(modes) = summary.get("modes").and_then(|v| v.as_array()) {
                            summary_modes.extend(modes.iter().cloned());
                        }
                    }
                    if let Some(diagnostics) = summary.get("solver_diagnostics") {
                        sample_solver_diagnostics.push(serde_json::json!({
                            "sample_index": sample_solver_diagnostics.len(),
                            "diagnostics": diagnostics,
                        }));
                    }
                }
                "eigen/diagnostics/solver.v1.json" => {
                    if solver_diagnostics_template.is_none() {
                        solver_diagnostics_template = Some(parse_sweep_artifact(
                            artifact,
                            "eigen/diagnostics/solver.v1.json",
                        )?);
                    }
                }
                "frequency_domain/manifest.v1.json" => {
                    if manifest_template.is_none() {
                        manifest_template = Some(parse_sweep_artifact(
                            artifact,
                            "frequency_domain/manifest.v1.json",
                        )?);
                    }
                }
                "eigen/spectrum.json"
                | "eigen/dispersion.csv"
                | "eigen/dispersion/branch_table.csv" => {}
                _ => {
                    if !include_completed_sample
                        && (artifact.relative_path.starts_with("eigen/modes/")
                            || artifact.relative_path.starts_with("eigen/mode_fields"))
                    {
                        continue;
                    }
                    if artifact_paths.insert(artifact.relative_path.clone()) {
                        artifacts.push(artifact.clone());
                    }
                }
            }
        }
    }

    spectrum_samples.sort_by_key(|sample| {
        sample
            .get("sample_index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    });
    let published_mode_count = spectrum_samples
        .iter()
        .filter_map(|sample| sample.get("modes").and_then(|v| v.as_array()))
        .map(Vec::len)
        .max()
        .unwrap_or(0);

    let mut branches = Vec::new();
    for (branch_id, template) in branch_templates {
        let mut branch = template;
        if let Some(object) = branch.as_object_mut() {
            let mut points = branch_points.remove(&branch_id).unwrap_or_default();
            points.sort_by_key(|point| {
                point
                    .get("sample_index")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            });
            object.insert("points".to_string(), serde_json::Value::Array(points));
        }
        branches.push(branch);
    }
    branches.sort_by_key(|branch| {
        branch
            .get("branch_id")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    });

    let spectrum = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_model": summary_template
            .as_ref()
            .and_then(|value| value.get("solver_kind"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "sample_count": spectrum_samples.len(),
        "mode_count": published_mode_count,
        "status": sweep_status_label,
        "complete": sweep_complete,
        "samples": spectrum_samples,
    });

    let mut summary = summary_template.ok_or_else(|| RunError {
        message: "bias-field sweep is missing eigen_summary.json".to_string(),
    })?;
    let mut diagnostics = solver_diagnostics_template
        .or_else(|| summary.get("solver_diagnostics").cloned())
        .ok_or_else(|| RunError {
            message: "bias-field sweep is missing solver diagnostics".to_string(),
        })?;
    if let Some(object) = diagnostics.as_object_mut() {
        object.insert("sample_count".to_string(), serde_json::json!(sample_count));
        object.insert(
            "mode_count".to_string(),
            serde_json::json!(published_mode_count),
        );
        object.insert(
            "sample_solver_diagnostics".to_string(),
            serde_json::Value::Array(sample_solver_diagnostics),
        );
        object.insert(
            "field_sweep".to_string(),
            serde_json::json!({
                "kind": "bias_field_sweep",
                "source": "bias_field_samples",
                "postsolve_oracle": "none",
                "sample_count": sample_count,
                "requested_sample_count": sample_count,
                "completed_sample_count": completed_sample_count,
                "status": artifact_status_label,
                "run_status": sweep_status_label,
                "stop_reason": sweep_stop_reason,
                "complete": sweep_complete,
                "independent_solves": true,
                "equilibrium_policy": bias_field_equilibrium_policy_label(equilibrium_policy),
                "continuation_seed": bias_field_continuation_seed_label(continuation_seed),
                "continuation_seed_scope": "first_sample_bootstrap",
            }),
        );
        object.insert(
            "status".to_string(),
            serde_json::json!(artifact_status_label),
        );
        object.insert("complete".to_string(), serde_json::json!(sweep_complete));
    }
    if let Some(object) = summary.as_object_mut() {
        object.insert(
            "mode_count".to_string(),
            serde_json::json!(summary_modes.len()),
        );
        object.insert("modes".to_string(), serde_json::Value::Array(summary_modes));
        object.insert("solver_diagnostics".to_string(), diagnostics.clone());
        object.insert("sample_count".to_string(), serde_json::json!(sample_count));
        object.insert(
            "status".to_string(),
            serde_json::json!(artifact_status_label),
        );
        object.insert("complete".to_string(), serde_json::json!(sweep_complete));
    }

    artifacts.push(json_artifact("eigen/spectrum.v2.json", &spectrum)?);
    artifacts.push(json_artifact("eigen/spectrum.json", &summary)?);
    artifacts.push(json_artifact(
        "eigen/metadata/eigen_summary.json",
        &summary,
    )?);
    artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &diagnostics,
    )?);
    let branches_payload = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "solver_model": summary["solver_kind"],
        "tracking_score_source": "seed_only",
        "modal_overlap_available": false,
        "branches": branches,
        "diagnostics": {
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
            "status": sweep_status_label,
            "complete": sweep_complete,
        },
    });
    artifacts.push(json_artifact("eigen/branches.v2.json", &branches_payload)?);
    let field_sweep = build_native_field_sweep_artifact(
        &spectrum,
        &branches_payload,
        &diagnostics,
        &artifacts,
        sample_count,
        sweep_status,
        sweep_stop_reason,
    )?;
    artifacts.push(json_artifact("eigen/field_sweep.v1.json", &field_sweep)?);

    let mut manifest = update_sweep_manifest(
        manifest_template.ok_or_else(|| RunError {
            message: "bias-field sweep is missing frequency-domain manifest".to_string(),
        })?,
        &artifacts,
        &diagnostics,
        sample_count,
    )?;
    if let Some(artifact_index) = manifest
        .get_mut("artifacts")
        .and_then(serde_json::Value::as_object_mut)
    {
        artifact_index.insert(
            "field_sweep_v1_path".to_string(),
            serde_json::json!("eigen/field_sweep.v1.json"),
        );
    }
    if let Some(resources) = manifest
        .get_mut("resources")
        .and_then(serde_json::Value::as_object_mut)
    {
        resources.insert(
            "field_sweep_resource_key".to_string(),
            serde_json::json!(
                "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep.v1"
            ),
        );
    }
    artifacts.push(json_artifact(
        "frequency_domain/manifest.v1.json",
        &manifest,
    )?);

    let mut dispersion = String::from(
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key\n",
    );
    for sample in spectrum["samples"].as_array().into_iter().flatten() {
        let sample_index = sample["sample_index"].as_u64().unwrap_or(0);
        let path_s = sample["path_s"].as_f64().unwrap_or(0.0);
        let label = sample["label"].as_str().unwrap_or("");
        let k = sample["k_vector"].as_array();
        let kx = k
            .and_then(|v| v.first())
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let ky = k
            .and_then(|v| v.get(1))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let kz = k
            .and_then(|v| v.get(2))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        for mode in sample["modes"].as_array().into_iter().flatten() {
            let raw_mode_index = mode["raw_mode_index"].as_u64().unwrap_or(0);
            dispersion.push_str(&format!(
                "{sample_index},{path_s:.16e},{kx:.16e},{ky:.16e},{kz:.16e},{label},{raw_mode_index},{},{:.16e},{:.16e},{},{},{},seed,{},{}\n",
                mode["branch_id"].as_u64().unwrap_or(raw_mode_index),
                mode["frequency_hz"].as_f64().unwrap_or(0.0),
                mode["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
                mode["frequency_imag_hz"].as_f64().map(|v| 2.0 * v).unwrap_or(0.0),
                mode["residual_norm"].as_f64().unwrap_or(0.0),
                "",
                mode["mode_field_id"].as_str().unwrap_or(""),
                mode["mode_field_resource_key"].as_str().unwrap_or(""),
            ));
        }
    }
    let dispersion_bytes = dispersion.into_bytes();
    artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/dispersion.csv".to_string(),
        bytes: dispersion_bytes.clone(),
    });
    artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/dispersion/branch_table.csv".to_string(),
        bytes: dispersion_bytes,
    });

    let mut result = all_runs.last().cloned().ok_or_else(|| RunError {
        message: "bias-field sweep lost its final sample".to_string(),
    })?;
    if result.result.status != sweep_status {
        result.result.status = sweep_status;
        result.result.completion = Some(crate::relaxation::resolve_stage_completion(
            sweep_status,
            None,
            crate::relaxation::RelaxationCompletionMetrics::default(),
        ));
    }
    result.initial_magnetization = all_runs
        .first()
        .map(|run| run.initial_magnetization.clone())
        .unwrap_or_default();
    result.result.steps = all_runs
        .iter()
        .flat_map(|run| run.result.steps.clone())
        .collect();
    result.auxiliary_artifacts = artifacts;
    Ok(result)
}

fn parse_sweep_artifact(
    artifact: &AuxiliaryArtifact,
    path: &str,
) -> Result<serde_json::Value, RunError> {
    serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
        message: format!("failed to parse {path} while merging bias-field sweep: {error}"),
    })
}

fn run_status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Paused => "paused",
    }
}

fn bias_field_equilibrium_policy_label(
    policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
) -> &'static str {
    match policy {
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach => "relax_each",
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation => "continuation",
    }
}

fn bias_field_continuation_seed_label(
    seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
) -> &'static str {
    match seed {
        fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium => {
            "previous_accepted_equilibrium"
        }
        fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState => "initial_state",
    }
}

fn update_sweep_manifest(
    mut manifest: serde_json::Value,
    artifacts: &[AuxiliaryArtifact],
    diagnostics: &serde_json::Value,
    sample_count: usize,
) -> Result<serde_json::Value, RunError> {
    let mode_metadata_paths: Vec<String> = artifacts
        .iter()
        .filter(|artifact| {
            artifact.relative_path.starts_with("eigen/modes/sample_")
                && artifact.relative_path.ends_with(".json")
        })
        .map(|artifact| artifact.relative_path.clone())
        .collect();
    let mode_field_resources: Vec<String> = artifacts
        .iter()
        .filter_map(|artifact| {
            if !artifact.relative_path.starts_with("eigen/modes/sample_") {
                return None;
            }
            let metadata = serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok()?;
            metadata
                .get("mode_field_resource_key")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .collect();
    if let Some(object) = manifest.as_object_mut() {
        object.insert("sample_count".to_string(), serde_json::json!(sample_count));
        object.insert(
            "diagnostics".to_string(),
            serde_json::json!({
                "tracking_score_source": "seed_only",
                "modal_overlap_available": false,
            }),
        );
        if let Some(artifacts_object) = object
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            artifacts_object.insert(
                "mode_metadata_paths".to_string(),
                serde_json::json!(mode_metadata_paths),
            );
        }
        if let Some(resources_object) = object
            .get_mut("resources")
            .and_then(serde_json::Value::as_object_mut)
        {
            resources_object.insert(
                "mode_field_resources".to_string(),
                serde_json::json!(mode_field_resources),
            );
        }
        if let Some(diagnostics_object) = diagnostics.as_object() {
            for key in [
                "sample_count",
                "field_sweep",
                "mode_count",
                "status",
                "complete",
            ] {
                if let Some(value) = diagnostics_object.get(key) {
                    object.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    Ok(manifest)
}

fn vector_norm(value: [f64; 3]) -> f64 {
    (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt()
}

#[derive(Debug, Clone)]
struct PeriodicDomainPairStats {
    magnetic_pair_count: u64,
    airbox_pair_count: u64,
    magnetic_pair_masses: Vec<f64>,
    airbox_pair_lengths_m: Vec<f64>,
}

fn tetra_volume_abs(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let cross = [
        ac[1] * ad[2] - ac[2] * ad[1],
        ac[2] * ad[0] - ac[0] * ad[2],
        ac[0] * ad[1] - ac[1] * ad[0],
    ];
    ((ab[0] * cross[0] + ab[1] * cross[1] + ab[2] * cross[2]) / 6.0).abs()
}

fn periodic_domain_pair_stats(
    mesh: &fullmag_ir::MeshIR,
) -> Result<PeriodicDomainPairStats, RunError> {
    let elements = mesh.require_tet4_elements().map_err(|error| RunError {
        message: format!("periodic eigen domain statistics are tet4-only: {error}"),
    })?;
    let mut magnetic_nodes = std::collections::BTreeSet::new();
    let mut airbox_nodes = std::collections::BTreeSet::new();
    let mut magnetic_node_lumped_volumes = vec![0.0; mesh.nodes.len()];
    for (element_index, element) in elements.iter().enumerate() {
        let marker = mesh
            .element_markers
            .get(element_index)
            .copied()
            .unwrap_or(1);
        let target = if marker == 0 {
            &mut airbox_nodes
        } else {
            &mut magnetic_nodes
        };
        target.extend(element.iter().copied());
        if marker != 0 {
            let a = mesh
                .nodes
                .get(element[0] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let b = mesh
                .nodes
                .get(element[1] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let c = mesh
                .nodes
                .get(element[2] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let d = mesh
                .nodes
                .get(element[3] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let volume = tetra_volume_abs(*a, *b, *c, *d);
            if !(volume.is_finite() && volume > 0.0) {
                return Err(RunError {
                    message: "PA-E4b periodic_airbox_k0 payload requires positive magnetic element volumes".to_string(),
                });
            }
            let lumped = volume / 4.0;
            for node in element {
                magnetic_node_lumped_volumes[*node as usize] += lumped;
            }
        }
    }
    let mut magnetic_count = 0_u64;
    let mut airbox_count = 0_u64;
    let mut magnetic_pair_masses = Vec::new();
    let mut airbox_pair_lengths_m = Vec::new();
    for pair in &mesh.periodic_node_pairs {
        let a_magnetic = magnetic_nodes.contains(&pair.node_a);
        let b_magnetic = magnetic_nodes.contains(&pair.node_b);
        let a_airbox = airbox_nodes.contains(&pair.node_a);
        let b_airbox = airbox_nodes.contains(&pair.node_b);
        if a_magnetic && b_magnetic {
            magnetic_count += 1;
            let mass = (magnetic_node_lumped_volumes[pair.node_a as usize]
                + magnetic_node_lumped_volumes[pair.node_b as usize])
                * 0.5;
            if !(mass.is_finite() && mass > 0.0) {
                return Err(RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload requires positive magnetic pair masses"
                            .to_string(),
                });
            }
            magnetic_pair_masses.push(mass);
        } else if !a_magnetic && !b_magnetic && (a_airbox || b_airbox) {
            airbox_count += 1;
            let a = mesh
                .nodes
                .get(pair.node_a as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload airbox pair references missing node"
                            .to_string(),
                })?;
            let b = mesh
                .nodes
                .get(pair.node_b as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload airbox pair references missing node"
                            .to_string(),
                })?;
            let length =
                ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            if !(length.is_finite() && length > 0.0) {
                return Err(RunError {
                    message: "PA-E4b periodic_airbox_k0 payload requires positive airbox periodic pair lengths".to_string(),
                });
            }
            airbox_pair_lengths_m.push(length);
        }
    }
    Ok(PeriodicDomainPairStats {
        magnetic_pair_count: magnetic_count,
        airbox_pair_count: airbox_count,
        magnetic_pair_masses,
        airbox_pair_lengths_m,
    })
}

fn pa_e4b_airbox_size_m(plan: &FemEigenPlanIR) -> Result<f64, RunError> {
    let factor = plan
        .air_box_config
        .as_ref()
        .map(|config| config.factor)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive air_box_config.factor and mesh extent".to_string(),
        })?;
    let mut min_corner = [f64::INFINITY; 3];
    let mut max_corner = [f64::NEG_INFINITY; 3];
    for node in &plan.mesh.nodes {
        for axis in 0..3 {
            min_corner[axis] = min_corner[axis].min(node[axis]);
            max_corner[axis] = max_corner[axis].max(node[axis]);
        }
    }
    let max_extent = (0..3)
        .map(|axis| max_corner[axis] - min_corner[axis])
        .filter(|extent| extent.is_finite() && *extent > 0.0)
        .fold(0.0_f64, f64::max);
    if !(max_extent.is_finite() && max_extent > 0.0) {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive air_box_config.factor and mesh extent".to_string(),
        });
    }
    Ok(max_extent * factor)
}

/// Resolve the physical Robin coefficient used by both the native static
/// FEM demag path and the shared-domain modal operator.  The coefficient is
/// based on the open-axis extent of the actual mesh; the public airbox
/// `factor` controls domain construction/metadata and is not an additional
/// multiplier for the boundary condition.
fn shared_domain_robin_beta_m(plan: &FemEigenPlanIR) -> Result<Option<f64>, RunError> {
    let Some(config) = plan.air_box_config.as_ref() else {
        return Ok(None);
    };
    if matches!(
        config.bc_kind.as_deref(),
        Some("dirichlet") | Some("pure_neumann")
    ) {
        return Ok(None);
    }
    let coefficient_factor = config.robin_beta_factor.unwrap_or(2.0);
    if !coefficient_factor.is_finite() || coefficient_factor <= 0.0 {
        return Err(RunError {
            message: "shared-domain Robin beta factor must be positive".to_string(),
        });
    }
    let mut min_corner = [f64::INFINITY; 3];
    let mut max_corner = [f64::NEG_INFINITY; 3];
    for node in &plan.mesh.nodes {
        for axis in 0..3 {
            min_corner[axis] = min_corner[axis].min(node[axis]);
            max_corner[axis] = max_corner[axis].max(node[axis]);
        }
    }
    let mut periodic_axis = [false; 3];
    for pair in &plan.mesh.periodic_boundary_pairs {
        if let Some(translation) = pair.translation {
            for axis in 0..3 {
                periodic_axis[axis] |= translation[axis].abs() > 1.0e-15;
            }
        }
    }
    let reference_extent = (0..3)
        .filter(|axis| !periodic_axis[*axis])
        .map(|axis| max_corner[axis] - min_corner[axis])
        .filter(|extent| extent.is_finite() && *extent > 0.0)
        .fold(0.0_f64, f64::max)
        .max(
            (0..3)
                .map(|axis| max_corner[axis] - min_corner[axis])
                .filter(|extent| extent.is_finite() && *extent > 0.0)
                .fold(0.0_f64, f64::max),
        );
    if !(reference_extent.is_finite() && reference_extent > 0.0) {
        return Err(RunError {
            message: "shared-domain Robin beta requires a positive mesh extent".to_string(),
        });
    }
    Ok(Some(coefficient_factor / (reference_extent * 0.5)))
}

#[derive(Debug, Clone)]
struct OwnedModalEigenCsrMatrix {
    row_count: u64,
    column_count: u64,
    row_offsets: Vec<u32>,
    column_indices: Vec<u32>,
    values: Vec<f64>,
}

impl OwnedModalEigenCsrMatrix {
    fn from_dense(row_count: u64, column_count: u64, values: &[f64]) -> Result<Self, RunError> {
        let expected = row_count
            .checked_mul(column_count)
            .and_then(|count| usize::try_from(count).ok())
            .ok_or_else(|| RunError {
                message: "PA-E4b Poisson-airbox payload dense block dimensions overflow"
                    .to_string(),
            })?;
        if values.len() != expected {
            return Err(RunError {
                message: "PA-E4b Poisson-airbox payload dense block shape mismatch".to_string(),
            });
        }
        let mut row_offsets = Vec::with_capacity(row_count as usize + 1);
        let mut column_indices = Vec::new();
        let mut csr_values = Vec::new();
        row_offsets.push(0);
        for row in 0..row_count {
            for column in 0..column_count {
                let value = values[(row * column_count + column) as usize];
                if value != 0.0 {
                    let column = u32::try_from(column).map_err(|_| RunError {
                        message: "PA-E4b Poisson-airbox payload CSR column index overflow"
                            .to_string(),
                    })?;
                    column_indices.push(column);
                    csr_values.push(value);
                }
            }
            row_offsets.push(u32::try_from(csr_values.len()).map_err(|_| RunError {
                message: "PA-E4b Poisson-airbox payload CSR nnz overflow".to_string(),
            })?);
        }
        Ok(Self {
            row_count,
            column_count,
            row_offsets,
            column_indices,
            values: csr_values,
        })
    }

    fn view(&self) -> native_fem::NativeModalEigenCsrMatrixView<'_> {
        native_fem::NativeModalEigenCsrMatrixView {
            row_count: self.row_count,
            column_count: self.column_count,
            row_offsets: &self.row_offsets,
            column_indices: &self.column_indices,
            values: &self.values,
        }
    }
}

#[derive(Debug, Clone)]
struct OwnedModalEigenPoissonAirboxBlockProblem {
    q_dof_count: u64,
    phi_dof_count: u64,
    a_qq_csr: OwnedModalEigenCsrMatrix,
    a_qphi_csr: OwnedModalEigenCsrMatrix,
    a_phiq_csr: OwnedModalEigenCsrMatrix,
    a_phiphi_csr: OwnedModalEigenCsrMatrix,
    b_qq_csr: OwnedModalEigenCsrMatrix,
    phi_mean_weights: Vec<f64>,
    target_frequency_hz: f64,
    expected_reference_frequency_hz: f64,
    magnetic_pair_count: u64,
    airbox_pair_count: u64,
    outer_boundary_kind: &'static str,
    robin_beta: f64,
    gauge_policy: &'static str,
    gauge_reason: &'static str,
    assembly_kind: &'static str,
}

fn modal_shared_domain_equivalence_classes(
    topology: &MeshTopology,
) -> Result<(Vec<u32>, u64, Vec<u32>, u64), RunError> {
    let node_count = topology.n_nodes;
    let mut parent: Vec<usize> = (0..node_count).collect();
    fn find(parent: &mut [usize], node: usize) -> usize {
        if parent[node] != node {
            let root = find(parent, parent[node]);
            parent[node] = root;
        }
        parent[node]
    }
    for (_, node_a, node_b) in &topology.periodic_node_pairs {
        let a = *node_a as usize;
        let b = *node_b as usize;
        if a >= node_count || b >= node_count {
            return Err(RunError {
                message: "shared-domain modal periodic node pair is outside the mesh".to_string(),
            });
        }
        let root_a = find(&mut parent, a);
        let root_b = find(&mut parent, b);
        if root_a != root_b {
            parent[root_b] = root_a;
        }
    }
    let mut scalar_roots = std::collections::BTreeMap::<usize, u32>::new();
    let mut scalar_classes = vec![0_u32; node_count];
    for node in 0..node_count {
        let root = find(&mut parent, node);
        let class = if let Some(class) = scalar_roots.get(&root) {
            *class
        } else {
            let class = scalar_roots.len() as u32;
            scalar_roots.insert(root, class);
            class
        };
        scalar_classes[node] = class;
    }
    let mut magnetic_roots = std::collections::BTreeMap::<usize, u32>::new();
    let mut root_has_magnetic = std::collections::BTreeMap::<usize, bool>::new();
    let mut root_has_air = std::collections::BTreeMap::<usize, bool>::new();
    for node in 0..node_count {
        let root = find(&mut parent, node);
        if topology.magnetic_node_volumes[node] > 0.0 {
            root_has_magnetic.insert(root, true);
        } else {
            root_has_air.insert(root, true);
        }
    }
    for root in root_has_magnetic.keys() {
        if root_has_air.get(root).copied().unwrap_or(false) {
            return Err(RunError {
                message:
                    "shared-domain modal periodic equivalence class mixes magnetic and air nodes"
                        .to_string(),
            });
        }
        magnetic_roots.insert(*root, magnetic_roots.len() as u32);
    }
    let mut magnetic_classes = vec![u32::MAX; node_count];
    for node in 0..node_count {
        if topology.magnetic_node_volumes[node] > 0.0 {
            let root = find(&mut parent, node);
            magnetic_classes[node] = *magnetic_roots.get(&root).ok_or_else(|| RunError {
                message: "shared-domain modal magnetic equivalence class is incomplete".to_string(),
            })?;
        }
    }
    Ok((
        scalar_classes,
        scalar_roots.len() as u64,
        magnetic_classes,
        magnetic_roots.len() as u64,
    ))
}

/// Bind the class maps handed to native to the accepted periodic certificate.
///
/// The native ABI receives compact class maps rather than the full certificate
/// object.  Rebuilding the maps here and recording their content digests makes
/// that projection fail closed: a stale/tampered map cannot be paired with a
/// current certificate or linearization state and still reach the solver.
fn build_modal_certificate_map_binding(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    certificate: &fullmag_ir::PeriodicMeshCertificateV6IR,
    scalar_classes: &[u32],
    scalar_class_count: u64,
    magnetic_classes: &[u32],
    magnetic_class_count: u64,
) -> Result<(serde_json::Value, String), RunError> {
    if certificate.schema_version != "periodic_mesh_certificate.v6"
        || certificate.certificate_status != "accepted"
    {
        return Err(RunError {
            message: "periodic_mesh_certificate_equivalence_map_binding_requires_accepted_v6"
                .to_string(),
        });
    }
    let expected_topology_fingerprint = plan.mesh.topology_fingerprint_v6();
    if certificate.topology_fingerprint != expected_topology_fingerprint {
        return Err(RunError {
            message: format!(
                "periodic_mesh_certificate_equivalence_map_binding_topology_mismatch: certificate='{}' mesh='{}'",
                certificate.topology_fingerprint, expected_topology_fingerprint
            ),
        });
    }
    let (expected_scalar, expected_scalar_count, expected_magnetic, expected_magnetic_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    if scalar_classes != expected_scalar
        || scalar_class_count != expected_scalar_count
        || magnetic_classes != expected_magnetic
        || magnetic_class_count != expected_magnetic_count
    {
        return Err(RunError {
            message: "periodic_mesh_certificate_equivalence_map_binding_map_mismatch".to_string(),
        });
    }

    let scalar_map_sha256 =
        shared_domain_content_digest("periodic_modal_scalar_reduced_node_map", scalar_classes)?;
    let magnetic_map_sha256 =
        shared_domain_content_digest("periodic_modal_magnetic_reduced_node_map", magnetic_classes)?;
    let binding = serde_json::json!({
        "schema_version": "periodic_modal_equivalence_map_binding.v1",
        "certificate_schema": certificate.schema_version,
        "certificate_status": certificate.certificate_status,
        "certificate_topology_fingerprint": certificate.topology_fingerprint,
        "certificate_scalar_equivalence_classes_sha256": certificate.scalar_equivalence_classes_sha256,
        "certificate_magnetic_equivalence_classes_sha256": certificate.magnetic_equivalence_classes_sha256,
        "scalar_reduced_node_count": scalar_classes.len(),
        "scalar_reduced_node_class_count": scalar_class_count,
        "scalar_reduced_node_sha256": scalar_map_sha256,
        "magnetic_reduced_node_count": magnetic_classes.len(),
        "magnetic_reduced_node_class_count": magnetic_class_count,
        "magnetic_reduced_node_sha256": magnetic_map_sha256,
    });
    let binding_digest =
        shared_domain_content_digest("periodic_modal_equivalence_map_binding", &binding)?;
    Ok((binding, binding_digest))
}

const MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH: u32 = 1;
const MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD: u32 = 2;
const MODAL_CERTIFICATE_PART_MAGNETIC: u32 = 1;
const MODAL_CERTIFICATE_PART_SCALAR_AIRBOX: u32 = 2;
const MODAL_CERTIFICATE_BINDING_ACCEPTED: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct OwnedModalCertificateV6Relation {
    pub source_node: u64,
    pub destination_node: u64,
    pub axis_mask: u32,
    pub kind: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct OwnedModalCertificateV6RegionRole {
    pub region_id: u32,
    pub part_role: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct OwnedModalCertificateV6ClassDigest {
    pub canonical_class_id: u64,
    pub member_count: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnedModalCertificateV6View {
    pub view_kind: u32,
    pub part_role: u32,
    pub part_identity: String,
    pub topology_fingerprint: String,
    pub region_ids: Vec<u32>,
    pub boundary_axis_masks: Vec<u32>,
    pub region_roles: Vec<OwnedModalCertificateV6RegionRole>,
    pub generator_relations: Vec<OwnedModalCertificateV6Relation>,
    pub closure_relations: Vec<OwnedModalCertificateV6Relation>,
    pub expected_class_ids: Vec<u64>,
    pub expected_class_digests: Vec<OwnedModalCertificateV6ClassDigest>,
}

impl OwnedModalCertificateV6View {
    fn node_count(&self) -> u64 {
        self.region_ids.len() as u64
    }

    fn canonical_state(
        &self,
    ) -> Result<(Vec<u64>, Vec<OwnedModalCertificateV6ClassDigest>, String), RunError> {
        let node_count = self.region_ids.len();
        if node_count == 0
            || self.boundary_axis_masks.len() != node_count
            || self.region_roles.is_empty()
            || self.generator_relations.is_empty()
            || self.closure_relations.is_empty()
            || !is_sha256_digest(&self.topology_fingerprint)
        {
            return Err(modal_v6_error("owned_view_incomplete"));
        }
        let expected_identity_prefix = if self.part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
            "magnetic:"
        } else if self.part_role == MODAL_CERTIFICATE_PART_SCALAR_AIRBOX {
            "airbox:"
        } else {
            return Err(modal_v6_error("owned_part_role_invalid"));
        };
        if !self.part_identity.starts_with(expected_identity_prefix) {
            return Err(modal_v6_error("owned_part_identity_invalid"));
        }
        let mut known_regions = BTreeSet::new();
        for role in &self.region_roles {
            if role.part_role != self.part_role || !known_regions.insert(role.region_id) {
                return Err(modal_v6_error("owned_region_role_invalid"));
            }
        }
        if self
            .region_ids
            .iter()
            .any(|region| !known_regions.contains(region))
            || self.boundary_axis_masks.iter().any(|mask| *mask > 7)
        {
            return Err(modal_v6_error("owned_node_identity_invalid"));
        }
        let mut parent = (0..node_count).collect::<Vec<_>>();
        fn find(parent: &mut [usize], mut node: usize) -> usize {
            let mut root = node;
            while parent[root] != root {
                root = parent[root];
            }
            while parent[node] != node {
                let next = parent[node];
                parent[node] = root;
                node = next;
            }
            root
        }
        let relation_key = |relation: &OwnedModalCertificateV6Relation| {
            (
                relation.source_node.min(relation.destination_node),
                relation.source_node.max(relation.destination_node),
                relation.axis_mask,
                relation.kind,
            )
        };
        let validate_relation = |relation: &OwnedModalCertificateV6Relation| {
            let source = relation.source_node as usize;
            let destination = relation.destination_node as usize;
            source < node_count
                && destination < node_count
                && source != destination
                && relation.axis_mask > 0
                && relation.axis_mask <= 7
                && relation.kind == relation.axis_mask.count_ones()
                && self.region_ids[source] == self.region_ids[destination]
                && (self.boundary_axis_masks[source] ^ self.boundary_axis_masks[destination])
                    == relation.axis_mask
        };
        let mut generator_pairs = BTreeSet::new();
        for relation in &self.generator_relations {
            if !validate_relation(relation)
                || !generator_pairs.insert((
                    relation.source_node.min(relation.destination_node),
                    relation.source_node.max(relation.destination_node),
                ))
            {
                return Err(modal_v6_error("owned_generator_invalid"));
            }
            let source = find(&mut parent, relation.source_node as usize);
            let destination = find(&mut parent, relation.destination_node as usize);
            if source != destination {
                parent[destination] = source;
            }
        }
        let mut closure = BTreeSet::new();
        for relation in &self.closure_relations {
            if !validate_relation(relation) || !closure.insert(relation_key(relation)) {
                return Err(modal_v6_error("owned_closure_invalid"));
            }
            if find(&mut parent, relation.source_node as usize)
                != find(&mut parent, relation.destination_node as usize)
            {
                return Err(modal_v6_error("owned_closure_outside_class"));
            }
        }
        if self
            .generator_relations
            .iter()
            .any(|relation| !closure.contains(&relation_key(relation)))
        {
            return Err(modal_v6_error("owned_generator_missing_from_closure"));
        }
        let mut classes = BTreeMap::<usize, Vec<u64>>::new();
        for node in 0..node_count {
            let root = find(&mut parent, node);
            classes.entry(root).or_default().push(node as u64);
        }
        let mut ordered = classes.into_values().collect::<Vec<_>>();
        ordered.sort_by_key(|members| members[0]);
        let mut class_ids = vec![0; node_count];
        for members in &ordered {
            for member in members {
                class_ids[*member as usize] = members[0];
            }
            for lhs in 0..members.len() {
                for rhs in lhs + 1..members.len() {
                    let source = members[lhs] as usize;
                    let destination = members[rhs] as usize;
                    let axis_mask =
                        self.boundary_axis_masks[source] ^ self.boundary_axis_masks[destination];
                    if axis_mask != 0
                        && !closure.contains(&(
                            members[lhs],
                            members[rhs],
                            axis_mask,
                            axis_mask.count_ones(),
                        ))
                    {
                        return Err(modal_v6_error(if axis_mask.count_ones() >= 3 {
                            "owned_corner_closure_incomplete"
                        } else if axis_mask.count_ones() == 2 {
                            "owned_edge_closure_incomplete"
                        } else {
                            "owned_face_closure_incomplete"
                        }));
                    }
                }
            }
        }
        let class_digests = ordered
            .iter()
            .map(|members| {
                let mut preimage = "periodic_modal_equivalence_class.v1\n".to_string();
                preimage.push_str("schema=periodic_mesh_certificate.v6\n");
                preimage.push_str(&format!(
                    "part_role={}\n",
                    if self.part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
                        "magnetic"
                    } else {
                        "scalar_airbox"
                    }
                ));
                append_modal_v6_text(&mut preimage, "part_identity", &self.part_identity);
                append_modal_v6_text(
                    &mut preimage,
                    "topology_fingerprint",
                    &self.topology_fingerprint,
                );
                preimage.push_str(&format!("canonical_class_id={}\n", members[0]));
                preimage.push_str(&format!("member_count={}\n", members.len()));
                for member in members {
                    preimage.push_str(&format!(
                        "member={},region={},boundary_axis_mask={}\n",
                        member,
                        self.region_ids[*member as usize],
                        self.boundary_axis_masks[*member as usize]
                    ));
                }
                OwnedModalCertificateV6ClassDigest {
                    canonical_class_id: members[0],
                    member_count: members.len() as u64,
                    sha256: sha256_text(&preimage),
                }
            })
            .collect::<Vec<_>>();
        let mut aggregate = "periodic_modal_equivalence_classes.v1\n".to_string();
        aggregate.push_str("schema=periodic_mesh_certificate.v6\n");
        for digest in &class_digests {
            aggregate.push_str(&format!(
                "class={},members={},digest={}\n",
                digest.canonical_class_id, digest.member_count, digest.sha256
            ));
        }
        Ok((class_ids, class_digests, sha256_text(&aggregate)))
    }

    fn validate(&self, view_kind: u32) -> Result<(), RunError> {
        if self.view_kind != view_kind {
            return Err(modal_v6_error("owned_view_kind_invalid"));
        }
        let (ids, digests, _) = self.canonical_state()?;
        if ids != self.expected_class_ids || digests != self.expected_class_digests {
            return Err(modal_v6_error("owned_class_metadata_mismatch"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OwnedModalCertificateV6Binding {
    pub mesh_generation_identity: String,
    pub mesh_magnetic: OwnedModalCertificateV6View,
    pub payload_magnetic: OwnedModalCertificateV6View,
    pub mesh_scalar: OwnedModalCertificateV6View,
    pub payload_scalar: OwnedModalCertificateV6View,
    pub canonical_preimage: String,
    pub canonical_preimage_sha256: String,
    pub magnetic_class_digest_sha256: String,
    pub scalar_class_digest_sha256: String,
    pub shared_domain_map_binding_sha256: String,
    pub boundary_gauge_digest: String,
    pub(crate) boundary_kind: String,
    pub(crate) boundary_marker: u32,
    pub(crate) robin_beta: f64,
    pub(crate) source_topology_fingerprint: String,
    pub bias_field_sample_index: u64,
    pub bias_field_sample_id: String,
    pub bias_field_sample_signature: String,
    pub(crate) bias_field_sample_a_per_m: Vec<f64>,
    pub(crate) cell_markers: Vec<u32>,
    pub(crate) scalar_reduced_node: Vec<u32>,
    pub(crate) scalar_reduced_class_count: u64,
    pub(crate) magnetic_reduced_node: Vec<u32>,
    pub(crate) magnetic_reduced_class_count: u64,
}

impl OwnedModalCertificateV6Binding {
    fn validate(&self) -> Result<(), RunError> {
        self.mesh_magnetic
            .validate(MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH)?;
        self.payload_magnetic
            .validate(MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD)?;
        self.mesh_scalar
            .validate(MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH)?;
        self.payload_scalar
            .validate(MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD)?;
        if !modal_v6_views_equal(&self.mesh_magnetic, &self.payload_magnetic)
            || !modal_v6_views_equal(&self.mesh_scalar, &self.payload_scalar)
            || self.mesh_magnetic.part_identity == self.mesh_scalar.part_identity
        {
            return Err(modal_v6_error("owned_mesh_payload_mismatch"));
        }
        let (_, _, magnetic_digest) = self.mesh_magnetic.canonical_state()?;
        let (_, _, scalar_digest) = self.mesh_scalar.canonical_state()?;
        let preimage = modal_v6_canonical_preimage(
            &self.mesh_generation_identity,
            &self.mesh_magnetic,
            &self.mesh_scalar,
        )?;
        if preimage != self.canonical_preimage
            || sha256_text(&preimage) != self.canonical_preimage_sha256
            || magnetic_digest != self.magnetic_class_digest_sha256
            || scalar_digest != self.scalar_class_digest_sha256
            || self.boundary_gauge_digest
                != shared_domain_content_digest(
                    "modal_boundary_gauge",
                    &(
                        self.boundary_kind.as_str(),
                        self.boundary_marker,
                        self.robin_beta,
                        self.source_topology_fingerprint.as_str(),
                    ),
                )?
            || self.bias_field_sample_id
                != format!("bias-field-sample:{}", self.bias_field_sample_index)
            || self.bias_field_sample_a_per_m.is_empty()
            || self
                .bias_field_sample_a_per_m
                .iter()
                .any(|value| !value.is_finite())
            || self.bias_field_sample_signature
                != shared_domain_content_digest(
                    "modal_bias_field_sample",
                    &(
                        self.bias_field_sample_index,
                        self.bias_field_sample_a_per_m.as_slice(),
                    ),
                )?
        {
            return Err(modal_v6_error("owned_binding_digest_mismatch"));
        }
        let map_digest = modal_shared_domain_map_binding_digest(
            &self.mesh_generation_identity,
            &self.mesh_magnetic,
            &self.mesh_scalar,
            &self.canonical_preimage_sha256,
            &self.magnetic_class_digest_sha256,
            &self.scalar_class_digest_sha256,
            &self.cell_markers,
            &self.scalar_reduced_node,
            self.scalar_reduced_class_count,
            &self.magnetic_reduced_node,
            self.magnetic_reduced_class_count,
        )?;
        if map_digest != self.shared_domain_map_binding_sha256 {
            return Err(modal_v6_error("owned_map_binding_digest_mismatch"));
        }
        Ok(())
    }
}

fn modal_v6_error(reason: &str) -> RunError {
    RunError {
        message: format!("periodic_mesh_certificate_v6_producer_{reason}"),
    }
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_text(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

fn append_modal_v6_text(preimage: &mut String, name: &str, value: &str) {
    preimage.push_str(&format!("{name}={}:{}\n", value.len(), value));
}

fn modal_certificate_marker_map_fingerprint(mesh: &fullmag_ir::MeshIR) -> String {
    let payload = serde_json::json!({
        "element_markers": mesh.element_markers,
        "boundary_markers": mesh.boundary_markers,
        "periodic_boundary_pairs": mesh.periodic_boundary_pairs.iter().map(|pair| {
            serde_json::json!({
                "pair_id": pair.pair_id,
                "marker_a": pair.marker_a,
                "marker_b": pair.marker_b,
                "axis": pair.axis_hint,
            })
        }).collect::<Vec<_>>(),
    });
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default())
    )
}

fn modal_v6_views_equal(
    mesh: &OwnedModalCertificateV6View,
    payload: &OwnedModalCertificateV6View,
) -> bool {
    mesh.part_role == payload.part_role
        && mesh.part_identity == payload.part_identity
        && mesh.topology_fingerprint == payload.topology_fingerprint
        && mesh.region_ids == payload.region_ids
        && mesh.boundary_axis_masks == payload.boundary_axis_masks
        && mesh.region_roles == payload.region_roles
        && mesh.generator_relations == payload.generator_relations
        && mesh.closure_relations == payload.closure_relations
        && mesh.expected_class_ids == payload.expected_class_ids
        && mesh.expected_class_digests == payload.expected_class_digests
}

fn append_modal_v6_view(
    preimage: &mut String,
    name: &str,
    view: &OwnedModalCertificateV6View,
) -> Result<(), RunError> {
    let (_, class_digests, _) = view.canonical_state()?;
    preimage.push_str(&format!(
        "{name}.part_role={}\n",
        if view.part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
            "magnetic"
        } else {
            "scalar_airbox"
        }
    ));
    append_modal_v6_text(
        preimage,
        &format!("{name}.part_identity"),
        &view.part_identity,
    );
    append_modal_v6_text(
        preimage,
        &format!("{name}.topology_fingerprint"),
        &view.topology_fingerprint,
    );
    preimage.push_str(&format!("{name}.node_count={}\n", view.node_count()));
    let mut roles = view.region_roles.clone();
    roles.sort_by_key(|role| (role.region_id, role.part_role));
    for role in roles {
        preimage.push_str(&format!(
            "{name}.region_role={},{}\n",
            role.region_id, role.part_role
        ));
    }
    for node in 0..view.region_ids.len() {
        preimage.push_str(&format!(
            "{name}.node={},region={},boundary_axis_mask={}\n",
            node, view.region_ids[node], view.boundary_axis_masks[node]
        ));
    }
    let mut generators = view.generator_relations.clone();
    generators.sort_by_key(|relation| {
        (
            relation.source_node.min(relation.destination_node),
            relation.source_node.max(relation.destination_node),
            relation.axis_mask,
            relation.kind,
        )
    });
    let mut closure = view.closure_relations.clone();
    closure.sort_by_key(|relation| {
        (
            relation.source_node.min(relation.destination_node),
            relation.source_node.max(relation.destination_node),
            relation.axis_mask,
            relation.kind,
        )
    });
    for (prefix, relations) in [("generator", generators), ("closure", closure)] {
        for relation in relations {
            preimage.push_str(&format!(
                "{name}.{prefix}={},{},{},{}\n",
                relation.source_node.min(relation.destination_node),
                relation.source_node.max(relation.destination_node),
                relation.axis_mask,
                relation.kind
            ));
        }
    }
    for digest in class_digests {
        preimage.push_str(&format!(
            "{name}.class={},members={},digest={}\n",
            digest.canonical_class_id, digest.member_count, digest.sha256
        ));
    }
    Ok(())
}

fn modal_v6_canonical_preimage(
    mesh_generation_identity: &str,
    magnetic: &OwnedModalCertificateV6View,
    scalar: &OwnedModalCertificateV6View,
) -> Result<String, RunError> {
    let mut preimage = "periodic_modal_equivalence_map_binding.v1\n".to_string();
    preimage.push_str("schema=periodic_mesh_certificate.v6\n");
    append_modal_v6_text(
        &mut preimage,
        "mesh_generation_identity",
        mesh_generation_identity,
    );
    append_modal_v6_view(&mut preimage, "magnetic", magnetic)?;
    append_modal_v6_view(&mut preimage, "scalar", scalar)?;
    Ok(preimage)
}

#[derive(Default)]
struct ModalCanonicalDigestBuilder(Vec<u8>);

impl ModalCanonicalDigestBuilder {
    fn new(schema: &str) -> Self {
        let mut builder = Self::default();
        builder.add_string("schema", schema);
        builder
    }

    fn add_field(&mut self, name: &str, kind: u8, value: &[u8]) {
        self.0.extend_from_slice(&(name.len() as u64).to_be_bytes());
        self.0.extend_from_slice(name.as_bytes());
        self.0.push(kind);
        self.0
            .extend_from_slice(&(value.len() as u64).to_be_bytes());
        self.0.extend_from_slice(value);
    }

    fn add_string(&mut self, name: &str, value: &str) {
        self.add_field(name, 1, value.as_bytes());
    }

    fn add_u64(&mut self, name: &str, value: u64) {
        self.add_field(name, 2, &value.to_be_bytes());
    }

    fn digest(&self) -> String {
        format!("sha256:{:x}", Sha256::digest(&self.0))
    }
}

#[allow(clippy::too_many_arguments)]
fn modal_shared_domain_map_binding_digest(
    mesh_generation_identity: &str,
    magnetic: &OwnedModalCertificateV6View,
    scalar: &OwnedModalCertificateV6View,
    canonical_preimage_sha256: &str,
    magnetic_class_digest_sha256: &str,
    scalar_class_digest_sha256: &str,
    cell_markers: &[u32],
    scalar_reduced_node: &[u32],
    scalar_reduced_class_count: u64,
    magnetic_reduced_node: &[u32],
    magnetic_reduced_class_count: u64,
) -> Result<String, RunError> {
    let node_count = scalar.node_count() as usize;
    let magnetic_count = magnetic.node_count() as usize;
    if scalar_reduced_node.len() != node_count
        || magnetic_reduced_node.len() != node_count
        || magnetic_count == 0
        || magnetic_count > node_count
    {
        return Err(modal_v6_error("map_binding_cardinality_invalid"));
    }
    validate_modal_reduction_map(
        &scalar.expected_class_ids,
        scalar_reduced_node,
        scalar_reduced_class_count,
        node_count,
        false,
    )?;
    validate_modal_reduction_map(
        &magnetic.expected_class_ids,
        magnetic_reduced_node,
        magnetic_reduced_class_count,
        node_count,
        true,
    )?;
    let mut digest = ModalCanonicalDigestBuilder::new("shared_domain_map_binding.v1");
    digest.add_string("mesh_generation_identity", mesh_generation_identity);
    digest.add_string(
        "node_order_contract",
        "scalar_global_nodes_authoritative;magnetic_compact_exact_prefix",
    );
    digest.add_u64("scalar_global_node_count", node_count as u64);
    digest.add_u64("magnetic_compact_node_count", magnetic_count as u64);
    for node in 0..node_count {
        digest.add_u64(
            &format!("global_node_magnetic_marker[{node}]"),
            u64::from(node < magnetic_count),
        );
    }
    for node in 0..magnetic_count {
        digest.add_u64(
            &format!("magnetic_compact_source_global_node[{node}]"),
            node as u64,
        );
    }
    digest.add_string("magnetic_part_identity", &magnetic.part_identity);
    digest.add_string("airbox_part_identity", &scalar.part_identity);
    digest.add_u64(
        "certificate_binding_status",
        MODAL_CERTIFICATE_BINDING_ACCEPTED as u64,
    );
    digest.add_string("certificate_binding_reason", "none");
    digest.add_string("v6_canonical_preimage_sha256", canonical_preimage_sha256);
    digest.add_string(
        "v6_magnetic_class_digest_sha256",
        magnetic_class_digest_sha256,
    );
    digest.add_string("v6_scalar_class_digest_sha256", scalar_class_digest_sha256);
    digest.add_u64("cell_marker_count", cell_markers.len() as u64);
    for (index, marker) in cell_markers.iter().enumerate() {
        digest.add_u64(&format!("cell_marker[{index}]"), *marker as u64);
    }
    for (name, ids) in [
        ("magnetic", &magnetic.expected_class_ids),
        ("scalar", &scalar.expected_class_ids),
    ] {
        digest.add_u64(
            &format!("{name}_canonical_class_id_count"),
            ids.len() as u64,
        );
        for (index, value) in ids.iter().enumerate() {
            digest.add_u64(&format!("{name}_canonical_class_id[{index}]"), *value);
        }
    }
    digest.add_u64("scalar_reduced_class_count", scalar_reduced_class_count);
    digest.add_u64("magnetic_reduced_class_count", magnetic_reduced_class_count);
    for node in 0..node_count {
        digest.add_u64(
            &format!("scalar_reduced_node[{node}]"),
            scalar_reduced_node[node] as u64,
        );
        digest.add_u64(
            &format!("magnetic_reduced_node[{node}]"),
            magnetic_reduced_node[node] as u64,
        );
    }
    Ok(digest.digest())
}

fn validate_modal_reduction_map(
    canonical_ids: &[u64],
    reduced: &[u32],
    class_count: u64,
    global_count: usize,
    magnetic_prefix: bool,
) -> Result<(), RunError> {
    if canonical_ids.is_empty()
        || canonical_ids.len() > global_count
        || reduced.len() != global_count
    {
        return Err(modal_v6_error("reduction_map_cardinality_invalid"));
    }
    let ordered = canonical_ids.iter().copied().collect::<BTreeSet<_>>();
    if ordered.len() as u64 != class_count {
        return Err(modal_v6_error("reduction_map_class_count_mismatch"));
    }
    let mapping = ordered
        .into_iter()
        .enumerate()
        .map(|(index, canonical)| (canonical, index as u32))
        .collect::<BTreeMap<_, _>>();
    if canonical_ids
        .iter()
        .enumerate()
        .any(|(node, id)| reduced[node] != mapping[id])
        || (magnetic_prefix
            && reduced[canonical_ids.len()..]
                .iter()
                .any(|value| *value != u32::MAX))
        || (!magnetic_prefix && canonical_ids.len() != global_count)
    {
        return Err(modal_v6_error("reduction_map_not_canonical"));
    }
    Ok(())
}

struct ModalV6PartRegistry {
    magnetic_identity: String,
    air_identity: String,
    magnetic_mask: Vec<bool>,
    magnetic_node_count: usize,
}

fn modal_participation_source_mesh_identity(
    plan: &FemEigenPlanIR,
) -> crate::eigen::ModalParticipationSourceMeshIdentity {
    crate::eigen::ModalParticipationSourceMeshIdentity {
        mesh_id: plan.mesh_name.clone(),
        topology_fingerprint: plan.mesh.topology_fingerprint_v6(),
        indexing: "full_domain_node_order".to_string(),
        node_count: plan.mesh.nodes.len(),
    }
}

fn modal_participation_for_mode(
    context: &Result<
        crate::eigen::ModalParticipationMeshContext,
        crate::eigen::ModalParticipationUnavailableDetail,
    >,
    plan: &FemEigenPlanIR,
    real: &[[f64; 3]],
    imag: &[[f64; 3]],
    solver_device: &str,
) -> crate::eigen::ModalParticipationObservable {
    match context {
        Ok(context) => context.compute(real, imag, solver_device),
        Err(detail) => crate::eigen::ModalParticipationObservable::unavailable(
            *detail,
            solver_device,
            Some(modal_participation_source_mesh_identity(plan)),
        ),
    }
}

fn modal_participation_mesh_context(
    plan: &FemEigenPlanIR,
) -> Result<crate::eigen::ModalParticipationMeshContext, crate::eigen::ModalParticipationUnavailableDetail>
{
    use crate::eigen::{
        ModalParticipationMeshContext, ModalParticipationObjectMarkerMembership,
        ModalParticipationUnavailableDetail,
    };
    use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector};

    if plan.fe_order != 1 {
        return Err(ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported);
    }
    let tet4_elements = plan
        .mesh
        .require_tet4_elements()
        .map_err(|_| ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported)?;
    if tet4_elements.is_empty() || plan.mesh.element_markers.len() != tet4_elements.len() {
        return Err(ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported);
    }

    let mut element_owners = vec![None::<String>; tet4_elements.len()];
    let mut saw_magnetic_part = false;
    for part in plan
        .mesh_parts
        .iter()
        .filter(|part| part.role == FemMeshPartRole::MagneticObject)
    {
        saw_magnetic_part = true;
        let object_id = part
            .object_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(ModalParticipationUnavailableDetail::ObjectMembershipMissing)?;
        let selected = match &part.element_selector {
            FemMeshPartSelector::ElementRange { start, count } => {
                let start = *start as usize;
                let end = start
                    .checked_add(*count as usize)
                    .filter(|end| *end <= tet4_elements.len())
                    .ok_or(ModalParticipationUnavailableDetail::ObjectMembershipMissing)?;
                (start..end).collect::<Vec<_>>()
            }
            FemMeshPartSelector::ElementMarkerSet { markers } => {
                if markers.is_empty() {
                    return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
                }
                let marker_set = markers.iter().copied().collect::<BTreeSet<_>>();
                if marker_set.len() != markers.len() {
                    return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
                }
                plan.mesh
                    .element_markers
                    .iter()
                    .enumerate()
                    .filter_map(|(index, marker)| marker_set.contains(marker).then_some(index))
                    .collect()
            }
            _ => return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing),
        };
        if selected.is_empty() {
            return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
        }
        for element_index in selected {
            if plan.mesh.element_markers[element_index] == 0 {
                return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
            }
            match &element_owners[element_index] {
                Some(existing) if existing != object_id => {
                    return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing)
                }
                Some(_) => {}
                None => element_owners[element_index] = Some(object_id.to_string()),
            }
        }
    }
    if !saw_magnetic_part {
        return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
    }

    let mut marker_owners = BTreeMap::<u32, String>::new();
    for (marker, owner) in plan.mesh.element_markers.iter().zip(&element_owners) {
        if *marker == 0 {
            if owner.is_some() {
                return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
            }
            continue;
        }
        let owner = owner
            .as_deref()
            .ok_or(ModalParticipationUnavailableDetail::ObjectCoverageIncomplete)?;
        if marker_owners
            .insert(*marker, owner.to_string())
            .is_some_and(|existing| existing != owner)
        {
            return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
        }
    }

    let mut object_markers = BTreeMap::<String, BTreeSet<u32>>::new();
    for (marker, object_id) in marker_owners {
        object_markers.entry(object_id).or_default().insert(marker);
    }
    if object_markers.is_empty() {
        return Err(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
    }

    Ok(ModalParticipationMeshContext {
        source_mesh_identity: modal_participation_source_mesh_identity(plan),
        nodes_m: plan.mesh.nodes.clone(),
        tet4_elements,
        element_markers: plan.mesh.element_markers.clone(),
        object_marker_membership: object_markers
            .into_iter()
            .map(|(object_id, markers)| ModalParticipationObjectMarkerMembership {
                object_id,
                markers: markers.into_iter().collect(),
            })
            .collect(),
    })
}

fn modal_v6_part_registry(
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
) -> Result<ModalV6PartRegistry, RunError> {
    use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector};

    let cells = mesh
        .require_tet4_elements()
        .map_err(|_| modal_v6_error("mesh_part_tet4_topology_invalid"))?;
    if mesh_parts.is_empty() {
        return Err(modal_v6_error("mesh_part_registry_missing"));
    }
    let mut part_ids = BTreeSet::new();
    if mesh_parts
        .iter()
        .any(|part| part.id.is_empty() || !part_ids.insert(part.id.as_str()))
    {
        return Err(modal_v6_error("mesh_part_id_duplicate"));
    }
    let magnetic_parts = mesh_parts
        .iter()
        .filter(|part| part.role == FemMeshPartRole::MagneticObject)
        .collect::<Vec<_>>();
    let air_parts = mesh_parts
        .iter()
        .filter(|part| part.role == FemMeshPartRole::Air)
        .collect::<Vec<_>>();
    if magnetic_parts.is_empty() || air_parts.len() != 1 {
        return Err(modal_v6_error("mesh_part_role_registry_invalid"));
    }
    let air_part = air_parts[0];
    let magnetic_object_id = magnetic_parts[0]
        .object_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| modal_v6_error("magnetic_part_owner_missing"))?;
    if magnetic_parts.iter().any(|part| {
        part.object_id.as_deref() != Some(magnetic_object_id)
            || part
                .geometry_id
                .as_deref()
                .is_some_and(|value| value.is_empty())
    }) {
        return Err(modal_v6_error("multiple_magnetic_objects_unsupported"));
    }
    if air_part.id != "part:__air__"
        || air_part.object_id.is_some()
        || air_part.geometry_id.is_some()
    {
        return Err(modal_v6_error("mesh_part_identity_mismatch"));
    }

    let resolve_elements = |part: &fullmag_ir::FemMeshPartIR| {
        let indices = match &part.element_selector {
            FemMeshPartSelector::ElementRange { start, count } => {
                let start = *start as usize;
                let end = start
                    .checked_add(*count as usize)
                    .filter(|end| *end <= cells.len())
                    .ok_or_else(|| modal_v6_error("mesh_part_element_selector_out_of_bounds"))?;
                (start..end).collect::<BTreeSet<_>>()
            }
            FemMeshPartSelector::ElementMarkerSet { markers } => {
                if markers.is_empty() {
                    return Err(modal_v6_error("mesh_part_element_marker_set_empty"));
                }
                let unique_markers = markers.iter().copied().collect::<BTreeSet<_>>();
                if unique_markers.len() != markers.len() {
                    return Err(modal_v6_error("mesh_part_element_marker_duplicate"));
                }
                mesh.element_markers
                    .iter()
                    .enumerate()
                    .filter_map(|(index, marker)| unique_markers.contains(marker).then_some(index))
                    .collect()
            }
            _ => return Err(modal_v6_error("mesh_part_element_selector_kind_invalid")),
        };
        if indices.is_empty() {
            return Err(modal_v6_error("mesh_part_element_selector_empty"));
        }
        Ok(indices)
    };
    let resolve_nodes = |part: &fullmag_ir::FemMeshPartIR| {
        let indices = if !part.node_indices.is_empty() {
            part.node_indices
                .iter()
                .map(|node| *node as usize)
                .collect::<BTreeSet<_>>()
        } else {
            match &part.node_selector {
                FemMeshPartSelector::NodeRange { start, count } => {
                    let start = *start as usize;
                    let end = start
                        .checked_add(*count as usize)
                        .filter(|end| *end <= mesh.nodes.len())
                        .ok_or_else(|| modal_v6_error("mesh_part_node_selector_out_of_bounds"))?;
                    (start..end).collect()
                }
                _ => return Err(modal_v6_error("mesh_part_node_selector_kind_invalid")),
            }
        };
        if indices.is_empty() || indices.iter().any(|node| *node >= mesh.nodes.len()) {
            return Err(modal_v6_error("mesh_part_node_selector_invalid"));
        }
        Ok(indices)
    };
    let validate_boundary_selector = |part: &fullmag_ir::FemMeshPartIR| {
        if !part.boundary_face_indices.is_empty() {
            if part
                .boundary_face_indices
                .iter()
                .any(|face| *face as usize >= mesh.facet_count())
            {
                return Err(modal_v6_error("mesh_part_boundary_selector_out_of_bounds"));
            }
            return Ok(());
        }
        match part.boundary_face_selector {
            FemMeshPartSelector::BoundaryFaceRange { start, count } => {
                let start = start as usize;
                start
                    .checked_add(count as usize)
                    .filter(|end| *end <= mesh.facet_count())
                    .map(|_| ())
                    .ok_or_else(|| modal_v6_error("mesh_part_boundary_selector_out_of_bounds"))
            }
            _ => Err(modal_v6_error("mesh_part_boundary_selector_kind_invalid")),
        }
    };

    let expected_magnetic_elements = mesh
        .element_markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| (*marker != 0).then_some(index))
        .collect::<BTreeSet<_>>();
    let expected_air_elements = mesh
        .element_markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| (*marker == 0).then_some(index))
        .collect::<BTreeSet<_>>();
    if expected_magnetic_elements.is_empty() || expected_air_elements.is_empty() {
        return Err(modal_v6_error("mesh_part_marker_partition_invalid"));
    }

    let mut selected_magnetic_elements = BTreeSet::new();
    let mut magnetic_markers = BTreeSet::new();
    let mut magnetic_parts_with_markers = Vec::with_capacity(magnetic_parts.len());
    let mut element_cursor = 0_usize;
    let mut owned_node_cursor = 0_usize;
    for part in magnetic_parts {
        let part_owner = part
            .geometry_id
            .as_deref()
            .or(part.object_id.as_deref())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| modal_v6_error("magnetic_part_owner_missing"))?;
        if part.id != format!("part:{part_owner}") {
            return Err(modal_v6_error("mesh_part_identity_mismatch"));
        }
        let selected_elements = resolve_elements(part)?;
        if selected_elements
            .iter()
            .any(|element| selected_magnetic_elements.contains(element))
        {
            return Err(modal_v6_error("mesh_part_element_overlap"));
        }
        let selected_markers = selected_elements
            .iter()
            .map(|element| mesh.element_markers[*element])
            .collect::<BTreeSet<_>>();
        if selected_markers.contains(&0) {
            return Err(modal_v6_error("magnetic_part_selects_air_marker"));
        }
        if selected_markers.len() != 1 {
            return Err(modal_v6_error("magnetic_part_marker_ambiguous"));
        }
        let marker = *selected_markers
            .first()
            .ok_or_else(|| modal_v6_error("magnetic_part_marker_missing"))?;
        if !magnetic_markers.insert(marker) {
            return Err(modal_v6_error("magnetic_marker_duplicate"));
        }
        let canonical_elements =
            (element_cursor..element_cursor + selected_elements.len()).collect::<BTreeSet<_>>();
        if selected_elements != canonical_elements {
            return Err(modal_v6_error("magnetic_part_order_noncanonical"));
        }
        if marker as usize != magnetic_parts_with_markers.len() + 1 {
            return Err(modal_v6_error("magnetic_marker_order_noncanonical"));
        }
        element_cursor += selected_elements.len();
        selected_magnetic_elements.extend(selected_elements.iter().copied());

        if !matches!(
            part.node_selector,
            FemMeshPartSelector::NodeRange { start, count }
                if start as usize == owned_node_cursor
                    && (start as usize).checked_add(count as usize)
                        .is_some_and(|end| end <= mesh.nodes.len())
        ) {
            return Err(modal_v6_error("mesh_part_node_selector_ownership_mismatch"));
        }
        let owned_node_count = match part.node_selector {
            FemMeshPartSelector::NodeRange { count, .. } => count as usize,
            _ => unreachable!("NodeRange was checked above"),
        };
        let owned_nodes =
            (owned_node_cursor..owned_node_cursor + owned_node_count).collect::<BTreeSet<_>>();
        owned_node_cursor += owned_node_count;
        let selected_nodes = resolve_nodes(part)?;
        let expected_nodes = selected_elements
            .iter()
            .flat_map(|element| cells[*element].iter().copied())
            .map(|node| node as usize)
            .collect::<BTreeSet<_>>();
        if selected_nodes != expected_nodes || !owned_nodes.is_subset(&selected_nodes) {
            return Err(modal_v6_error("mesh_part_node_selector_topology_mismatch"));
        }
        validate_boundary_selector(part)?;
        magnetic_parts_with_markers.push((part, marker));
    }
    if selected_magnetic_elements != expected_magnetic_elements {
        return Err(modal_v6_error("magnetic_marker_uncovered"));
    }

    let selected_air_elements = resolve_elements(air_part)?;
    if selected_air_elements != expected_air_elements
        || selected_air_elements
            .iter()
            .any(|element| selected_magnetic_elements.contains(element))
    {
        return Err(modal_v6_error("air_part_element_selector_marker_mismatch"));
    }
    let mut magnetic_mask = vec![false; mesh.nodes.len()];
    for element in &selected_magnetic_elements {
        for node in &cells[*element] {
            let is_magnetic = magnetic_mask
                .get_mut(*node as usize)
                .ok_or_else(|| modal_v6_error("marker_node_invalid"))?;
            *is_magnetic = true;
        }
    }
    let magnetic_node_count = magnetic_mask.iter().take_while(|value| **value).count();
    if magnetic_node_count == 0
        || magnetic_mask[magnetic_node_count..]
            .iter()
            .any(|value| *value)
        || magnetic_node_count != owned_node_cursor
    {
        return Err(modal_v6_error("magnetic_nodes_not_exact_prefix"));
    }
    if !matches!(
        air_part.node_selector,
        FemMeshPartSelector::NodeRange { start, count }
            if start as usize == magnetic_node_count
                && count as usize == mesh.nodes.len() - magnetic_node_count
    ) {
        return Err(modal_v6_error("mesh_part_node_selector_ownership_mismatch"));
    }
    let selected_air_nodes = resolve_nodes(air_part)?;
    let expected_air_nodes = selected_air_elements
        .iter()
        .flat_map(|element| cells[*element].iter().copied())
        .map(|node| node as usize)
        .collect::<BTreeSet<_>>();
    if selected_air_nodes != expected_air_nodes {
        return Err(modal_v6_error("mesh_part_node_selector_topology_mismatch"));
    }
    validate_boundary_selector(air_part)?;

    let mut magnetic_identity = format!(
        "magnetic:object-id={}:{};part-count={}",
        magnetic_object_id.len(),
        magnetic_object_id,
        magnetic_parts_with_markers.len()
    );
    for (index, (part, marker)) in magnetic_parts_with_markers.iter().enumerate() {
        magnetic_identity.push_str(&format!(
            ";part[{index}]-id={}:{};part[{index}]-marker={marker}",
            part.id.len(),
            part.id
        ));
    }

    Ok(ModalV6PartRegistry {
        magnetic_identity,
        air_identity: format!("airbox:part-id={}:{}", air_part.id.len(), air_part.id),
        magnetic_mask,
        magnetic_node_count,
    })
}

#[cfg(test)]
fn modal_v6_part_identities(
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    magnetic_node_count: usize,
) -> Result<(String, String), RunError> {
    let registry = modal_v6_part_registry(mesh, mesh_parts)?;
    if registry.magnetic_node_count != magnetic_node_count {
        return Err(modal_v6_error("magnetic_node_count_registry_mismatch"));
    }
    Ok((registry.magnetic_identity, registry.air_identity))
}

#[allow(clippy::too_many_arguments)]
fn build_owned_modal_certificate_v6_binding(
    mesh: &fullmag_ir::MeshIR,
    certificate: &fullmag_ir::PeriodicMeshCertificateV6IR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    ms_nodal_field: Option<&[f64]>,
    a_nodal_field: Option<&[f64]>,
    scalar_reduced_node: &[u32],
    scalar_reduced_class_count: u64,
    magnetic_reduced_node: &[u32],
    magnetic_reduced_class_count: u64,
    boundary_kind: &str,
    boundary_marker: u32,
    robin_beta: f64,
    bias_field_sample_index: u64,
    bias_field_a_per_m: &[f64],
) -> Result<OwnedModalCertificateV6Binding, RunError> {
    let authoritative_certificate = mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            ms_nodal_field,
            a_nodal_field,
        )
        .map_err(|_| modal_v6_error("authoritative_certificate_rebuild_failed"))?;
    if certificate.schema_version != "periodic_mesh_certificate.v6"
        || certificate.certificate_status != "accepted"
        || certificate != &authoritative_certificate
        || certificate.topology_fingerprint != mesh.topology_fingerprint_v6()
        || certificate.marker_map_fingerprint != modal_certificate_marker_map_fingerprint(mesh)
        || !certificate.boundary_topology_match
        || !certificate.material_region_match
        || !certificate.corner_edge_cycle_unique
    {
        return Err(modal_v6_error("accepted_certificate_missing_or_stale"));
    }
    let cells = mesh
        .require_tet4_elements()
        .map_err(|_| modal_v6_error("tet4_marker_map_invalid"))?;
    if mesh.element_markers.len() != cells.len() {
        return Err(modal_v6_error("marker_map_invalid"));
    }
    let part_registry = modal_v6_part_registry(mesh, mesh_parts)?;
    let node_count = mesh.nodes.len();
    let magnetic_node_count = part_registry.magnetic_node_count;
    let magnetic_mask = part_registry.magnetic_mask;
    let mut axis_by_pair = BTreeMap::<String, u32>::new();
    for pair in &mesh.periodic_boundary_pairs {
        let axis = pair
            .axis_hint
            .as_deref()
            .and_then(|axis| match axis {
                "x" => Some(1),
                "y" => Some(2),
                "z" => Some(4),
                _ => None,
            })
            .or_else(|| {
                pair.translation.and_then(|translation| {
                    let nonzero = translation
                        .iter()
                        .enumerate()
                        .filter(|(_, value)| value.abs() > 1.0e-15)
                        .map(|(axis, _)| 1_u32 << axis)
                        .collect::<Vec<_>>();
                    (nonzero.len() == 1).then_some(nonzero[0])
                })
            })
            .ok_or_else(|| modal_v6_error("periodic_axis_ambiguous"))?;
        if axis_by_pair
            .insert(pair.pair_id.clone(), axis)
            .is_some_and(|previous| previous != axis)
        {
            return Err(modal_v6_error("periodic_axis_conflict"));
        }
    }
    if axis_by_pair.iter().any(|(pair_id, mask)| {
        let axis = match *mask {
            1 => "x",
            2 => "y",
            4 => "z",
            _ => return true,
        };
        !certificate
            .axis_pairs
            .iter()
            .any(|evidence| evidence.pair_id == *pair_id && evidence.axis.as_deref() == Some(axis))
    }) {
        return Err(modal_v6_error("certificate_axis_evidence_missing"));
    }
    let generators = mesh
        .periodic_node_pairs
        .iter()
        .map(|pair| {
            let axis_mask = *axis_by_pair
                .get(&pair.pair_id)
                .ok_or_else(|| modal_v6_error("periodic_pair_axis_missing"))?;
            if pair.node_a as usize >= node_count || pair.node_b as usize >= node_count {
                return Err(modal_v6_error("periodic_pair_node_invalid"));
            }
            Ok(OwnedModalCertificateV6Relation {
                source_node: pair.node_a.min(pair.node_b) as u64,
                destination_node: pair.node_a.max(pair.node_b) as u64,
                axis_mask,
                kind: 1,
            })
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let mut adjacency = vec![Vec::<(usize, u32)>::new(); node_count];
    for relation in &generators {
        let source = relation.source_node as usize;
        let destination = relation.destination_node as usize;
        adjacency[source].push((destination, relation.axis_mask));
        adjacency[destination].push((source, relation.axis_mask));
    }
    let mut masks = vec![None; node_count];
    for root in 0..node_count {
        if masks[root].is_some() {
            continue;
        }
        masks[root] = Some(0);
        let mut queue = VecDeque::from([root]);
        while let Some(node) = queue.pop_front() {
            let node_mask = masks[node].unwrap_or(0);
            for (neighbor, axis) in &adjacency[node] {
                let expected = node_mask ^ axis;
                match masks[*neighbor] {
                    Some(actual) if actual != expected => {
                        return Err(modal_v6_error("periodic_axis_cycle_inconsistent"));
                    }
                    Some(_) => {}
                    None => {
                        masks[*neighbor] = Some(expected);
                        queue.push_back(*neighbor);
                    }
                }
            }
        }
    }
    let masks = masks.into_iter().map(Option::unwrap).collect::<Vec<_>>();
    let make_view = |view_kind: u32,
                     part_role: u32,
                     part_len: usize,
                     part_identity: String,
                     topology_fingerprint: String|
     -> Result<OwnedModalCertificateV6View, RunError> {
        let region_ids = if part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
            vec![1; part_len]
        } else {
            magnetic_mask
                .iter()
                .map(|is_magnetic| u32::from(*is_magnetic))
                .collect()
        };
        let region_roles = region_ids
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|region_id| OwnedModalCertificateV6RegionRole {
                region_id,
                part_role,
            })
            .collect::<Vec<_>>();
        let mut view_generators = Vec::new();
        for relation in &generators {
            let source_in = relation.source_node < part_len as u64;
            let destination_in = relation.destination_node < part_len as u64;
            if source_in != destination_in && part_role == MODAL_CERTIFICATE_PART_MAGNETIC {
                return Err(modal_v6_error("periodic_relation_crosses_magnetic_prefix"));
            }
            if source_in && destination_in {
                view_generators.push(relation.clone());
            }
        }
        view_generators.sort_by_key(|relation| {
            (
                relation.source_node,
                relation.destination_node,
                relation.axis_mask,
            )
        });
        let mut parent = (0..part_len).collect::<Vec<_>>();
        fn root(parent: &mut [usize], node: usize) -> usize {
            if parent[node] != node {
                parent[node] = root(parent, parent[node]);
            }
            parent[node]
        }
        for relation in &view_generators {
            let source = root(&mut parent, relation.source_node as usize);
            let destination = root(&mut parent, relation.destination_node as usize);
            if source != destination {
                parent[destination] = source;
            }
        }
        let mut classes = BTreeMap::<usize, Vec<usize>>::new();
        for node in 0..part_len {
            let class = root(&mut parent, node);
            classes.entry(class).or_default().push(node);
        }
        let mut closure_relations = Vec::new();
        for members in classes.values() {
            for lhs in 0..members.len() {
                for rhs in lhs + 1..members.len() {
                    let source = members[lhs];
                    let destination = members[rhs];
                    let axis_mask = masks[source] ^ masks[destination];
                    if axis_mask != 0 {
                        closure_relations.push(OwnedModalCertificateV6Relation {
                            source_node: source as u64,
                            destination_node: destination as u64,
                            axis_mask,
                            kind: axis_mask.count_ones(),
                        });
                    }
                }
            }
        }
        closure_relations.sort_by_key(|relation| {
            (
                relation.source_node,
                relation.destination_node,
                relation.axis_mask,
                relation.kind,
            )
        });
        let mut view = OwnedModalCertificateV6View {
            view_kind,
            part_role,
            part_identity,
            topology_fingerprint,
            region_ids,
            boundary_axis_masks: masks[..part_len].to_vec(),
            region_roles,
            generator_relations: view_generators,
            closure_relations,
            expected_class_ids: Vec::new(),
            expected_class_digests: Vec::new(),
        };
        let (ids, digests, _) = view.canonical_state()?;
        view.expected_class_ids = ids;
        view.expected_class_digests = digests;
        Ok(view)
    };
    let magnetic_topology = shared_domain_content_digest(
        "periodic_modal_magnetic_view_topology",
        &(
            &certificate.topology_fingerprint,
            &certificate.marker_map_fingerprint,
            magnetic_node_count,
            &masks[..magnetic_node_count],
            &generators,
        ),
    )?;
    let scalar_topology = shared_domain_content_digest(
        "periodic_modal_scalar_view_topology",
        &(
            &certificate.topology_fingerprint,
            &certificate.marker_map_fingerprint,
            node_count,
            &masks,
            &generators,
        ),
    )?;
    let magnetic_identity = part_registry.magnetic_identity;
    let scalar_identity = part_registry.air_identity;
    let mesh_magnetic = make_view(
        MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH,
        MODAL_CERTIFICATE_PART_MAGNETIC,
        magnetic_node_count,
        magnetic_identity.clone(),
        magnetic_topology.clone(),
    )?;
    let payload_magnetic = make_view(
        MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD,
        MODAL_CERTIFICATE_PART_MAGNETIC,
        magnetic_node_count,
        magnetic_identity,
        magnetic_topology,
    )?;
    let mesh_scalar = make_view(
        MODAL_CERTIFICATE_VIEW_AUTHORITATIVE_MESH,
        MODAL_CERTIFICATE_PART_SCALAR_AIRBOX,
        node_count,
        scalar_identity.clone(),
        scalar_topology.clone(),
    )?;
    let payload_scalar = make_view(
        MODAL_CERTIFICATE_VIEW_COMPACT_PAYLOAD,
        MODAL_CERTIFICATE_PART_SCALAR_AIRBOX,
        node_count,
        scalar_identity,
        scalar_topology,
    )?;
    let view_class_evidence = |view: &OwnedModalCertificateV6View| {
        let mut members = BTreeMap::<u64, u64>::new();
        for class_id in &view.expected_class_ids {
            *members.entry(*class_id).or_default() += 1;
        }
        (
            members.values().filter(|count| **count > 1).count() as u64,
            members
                .values()
                .map(|count| count.saturating_sub(1))
                .sum::<u64>(),
        )
    };
    let (magnetic_view_class_count, magnetic_view_pair_count) = view_class_evidence(&mesh_magnetic);
    let (scalar_view_class_count, scalar_view_pair_count) = view_class_evidence(&mesh_scalar);
    if magnetic_view_class_count != certificate.magnetic_class_count
        || magnetic_view_pair_count != certificate.magnetic_pair_count
        || scalar_view_class_count != certificate.scalar_class_count
        || scalar_view_pair_count != certificate.scalar_pair_count
    {
        return Err(modal_v6_error("certificate_view_class_evidence_mismatch"));
    }
    let mesh_generation_identity = format!("mesh-generation:{}", certificate.topology_fingerprint);
    let canonical_preimage =
        modal_v6_canonical_preimage(&mesh_generation_identity, &mesh_magnetic, &mesh_scalar)?;
    let canonical_preimage_sha256 = sha256_text(&canonical_preimage);
    let (_, _, magnetic_class_digest_sha256) = mesh_magnetic.canonical_state()?;
    let (_, _, scalar_class_digest_sha256) = mesh_scalar.canonical_state()?;
    let boundary_gauge_digest = shared_domain_content_digest(
        "modal_boundary_gauge",
        &(
            boundary_kind,
            boundary_marker,
            robin_beta,
            &certificate.topology_fingerprint,
        ),
    )?;
    if bias_field_a_per_m.is_empty() || bias_field_a_per_m.iter().any(|value| !value.is_finite()) {
        return Err(modal_v6_error("bias_field_sample_invalid"));
    }
    let bias_field_sample_signature = shared_domain_content_digest(
        "modal_bias_field_sample",
        &(bias_field_sample_index, bias_field_a_per_m),
    )?;
    let bias_field_sample_id = format!("bias-field-sample:{bias_field_sample_index}");
    let operator_cell_markers = mesh
        .element_markers
        .iter()
        .map(|marker| u32::from(*marker != 0))
        .collect::<Vec<_>>();
    let shared_domain_map_binding_sha256 = modal_shared_domain_map_binding_digest(
        &mesh_generation_identity,
        &mesh_magnetic,
        &mesh_scalar,
        &canonical_preimage_sha256,
        &magnetic_class_digest_sha256,
        &scalar_class_digest_sha256,
        &operator_cell_markers,
        scalar_reduced_node,
        scalar_reduced_class_count,
        magnetic_reduced_node,
        magnetic_reduced_class_count,
    )?;
    let binding = OwnedModalCertificateV6Binding {
        mesh_generation_identity,
        mesh_magnetic,
        payload_magnetic,
        mesh_scalar,
        payload_scalar,
        canonical_preimage,
        canonical_preimage_sha256,
        magnetic_class_digest_sha256,
        scalar_class_digest_sha256,
        shared_domain_map_binding_sha256,
        boundary_gauge_digest,
        boundary_kind: boundary_kind.to_string(),
        boundary_marker,
        robin_beta,
        source_topology_fingerprint: certificate.topology_fingerprint.clone(),
        bias_field_sample_index,
        bias_field_sample_id,
        bias_field_sample_signature,
        bias_field_sample_a_per_m: bias_field_a_per_m.to_vec(),
        cell_markers: operator_cell_markers,
        scalar_reduced_node: scalar_reduced_node.to_vec(),
        scalar_reduced_class_count,
        magnetic_reduced_node: magnetic_reduced_node.to_vec(),
        magnetic_reduced_class_count,
    };
    binding.validate()?;
    Ok(binding)
}

fn reduced_shared_domain_tangent_mass(
    topology: &MeshTopology,
    full_mass: &DMatrix<f64>,
) -> Result<(DMatrix<f64>, Vec<usize>, Vec<u32>, usize), RunError> {
    let active_nodes = topology
        .magnetic_node_volumes
        .iter()
        .enumerate()
        .filter_map(|(node, volume)| (*volume > 0.0).then_some(node))
        .collect::<Vec<_>>();
    let active_count = active_nodes.len();
    if full_mass.nrows() != 2usize.saturating_mul(active_count)
        || full_mass.ncols() != full_mass.nrows()
    {
        return Err(RunError {
            message: "shared-domain modal full tangent mass dimensions do not match active nodes"
                .to_string(),
        });
    }
    let (_, _, magnetic_classes, magnetic_class_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    let magnetic_class_count = usize::try_from(magnetic_class_count).map_err(|_| RunError {
        message: "shared-domain magnetic equivalence class count exceeds host dimensions"
            .to_string(),
    })?;
    let mut active_classes = Vec::with_capacity(active_count);
    for node in &active_nodes {
        let class = *magnetic_classes.get(*node).ok_or_else(|| RunError {
            message: "shared-domain magnetic class map is shorter than the mesh".to_string(),
        })?;
        if class == u32::MAX || class as usize >= magnetic_class_count {
            return Err(RunError {
                message: "shared-domain active node has no valid magnetic equivalence class"
                    .to_string(),
            });
        }
        active_classes.push(class as usize);
    }
    let reduced_dimension = 2usize
        .checked_mul(magnetic_class_count)
        .ok_or_else(|| RunError {
            message: "shared-domain reduced tangent mass dimensions overflow".to_string(),
        })?;
    let mut reduced_mass = DMatrix::<f64>::zeros(reduced_dimension, reduced_dimension);
    for row_component in 0..2usize {
        for column_component in 0..2usize {
            for (row_position, row_class) in active_classes.iter().copied().enumerate() {
                for (column_position, column_class) in active_classes.iter().copied().enumerate() {
                    reduced_mass[(
                        row_component * magnetic_class_count + row_class,
                        column_component * magnetic_class_count + column_class,
                    )] += full_mass[(
                        row_component * active_count + row_position,
                        column_component * active_count + column_position,
                    )];
                }
            }
        }
    }
    Ok((
        reduced_mass,
        active_nodes,
        magnetic_classes,
        magnetic_class_count,
    ))
}

/// Validation-only dense-reference oracle. Production shared-domain handoff
/// must never construct or transport runner-owned A_qq.
#[cfg(test)]
fn validation_oracle_full_interleaved_modal_a_qq_csr(
    block_matrix: &DMatrix<f64>,
    active_nodes: &[usize],
    full_node_count: usize,
    energy_scale: f64,
) -> Result<(Vec<u32>, Vec<u32>, Vec<f64>), RunError> {
    let active_count = active_nodes.len();
    let block_dimension = active_count.checked_mul(2).ok_or_else(|| RunError {
        message: "shared-domain modal A_qq dimension overflow".to_string(),
    })?;
    if block_matrix.nrows() != block_dimension || block_matrix.ncols() != block_dimension {
        return Err(RunError {
            message: "shared-domain modal A_qq source has an unexpected dimension".to_string(),
        });
    }
    let full_dimension = full_node_count.checked_mul(2).ok_or_else(|| RunError {
        message: "shared-domain modal full A_qq dimension overflow".to_string(),
    })?;
    let mut active_position = vec![None; full_node_count];
    for (position, node) in active_nodes.iter().copied().enumerate() {
        if node >= full_node_count {
            return Err(RunError {
                message: "shared-domain modal active node is outside the mesh".to_string(),
            });
        }
        active_position[node] = Some(position);
    }
    let mut row_offsets = Vec::with_capacity(full_dimension + 1);
    let mut columns = Vec::new();
    let mut values = Vec::new();
    row_offsets.push(0);
    for node in 0..full_node_count {
        for component in 0..2 {
            if let Some(row_position) = active_position[node] {
                let row_block = component * active_count + row_position;
                for column_node in active_nodes.iter().copied() {
                    let Some(column_position) = active_position[column_node] else {
                        continue;
                    };
                    for column_component in 0..2 {
                        let column_block = column_component * active_count + column_position;
                        let value = block_matrix[(row_block, column_block)] * energy_scale;
                        if !value.is_finite() {
                            return Err(RunError {
                                message: "shared-domain modal A_qq contains a non-finite value"
                                    .to_string(),
                            });
                        }
                        if value != 0.0 {
                            columns.push((2 * column_node + column_component) as u32);
                            values.push(value);
                        }
                    }
                }
            }
            if values.len() > u32::MAX as usize {
                return Err(RunError {
                    message: "shared-domain modal A_qq CSR exceeds u32 index range".to_string(),
                });
            }
            row_offsets.push(values.len() as u32);
        }
    }
    Ok((row_offsets, columns, values))
}

fn shared_domain_content_digest<T: serde::Serialize + ?Sized>(
    label: &str,
    value: &T,
) -> Result<String, RunError> {
    let encoded = serde_json::to_vec(value).map_err(|error| RunError {
        message: format!("failed to serialize shared-domain {label} digest input: {error}"),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn max_vector_field_difference(left: &[Vector3], right: &[Vector3]) -> Option<f64> {
    if left.len() != right.len() {
        return None;
    }
    Some(
        left.iter()
            .zip(right)
            .map(|(left, right)| {
                (0..3)
                    .map(|axis| (left[axis] - right[axis]).abs())
                    .fold(0.0, f64::max)
            })
            .fold(0.0, f64::max),
    )
}

fn max_scalar_field_difference(left: &[f64], right: &[f64]) -> Option<f64> {
    if left.len() != right.len() {
        return None;
    }
    Some(
        left.iter()
            .zip(right)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0, f64::max),
    )
}

fn extend_equilibrium_m0_to_air_nodes(
    topology: &MeshTopology,
    equilibrium: &[Vector3],
) -> Vec<Vector3> {
    equilibrium
        .iter()
        .zip(topology.magnetic_node_volumes.iter())
        .map(|(m, magnetic_volume)| {
            if *magnetic_volume > 0.0 {
                *m
            } else {
                [0.0, 0.0, 1.0]
            }
        })
        .collect()
}

fn build_shared_domain_linearization_state(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    problem: &FemLlgProblem,
    source_artifact: Option<&LoadedEquilibriumArtifactV7>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
    equilibrium: &[Vector3],
    observables: &EffectiveFieldObservables,
) -> Result<SharedDomainLinearizationState, RunError> {
    validate_shared_domain_modal_scope(plan, topology, equilibrium, observables)?;
    let phi0 = if let Some(handoff) = source_relax_handoff {
        validate_certified_equilibrium_fields(&handoff.certified_fields, topology.n_nodes)?;
        handoff.certified_fields.phi_a.clone()
    } else {
        problem
            .demag_potential_from_vectors(equilibrium)
            .map_err(|error| RunError {
                message: format!(
                    "shared-domain modal equilibrium potential materialization failed: {error}"
                ),
            })?
    };
    if phi0.len() != topology.n_nodes || phi0.iter().any(|value| !value.is_finite()) {
        return Err(RunError {
            message: format!(
                "shared-domain modal equilibrium potential is incomplete or non-finite (expected {} values, got {})",
                topology.n_nodes,
                phi0.len()
            ),
        });
    }

    let mesh_signature = plan.mesh.topology_fingerprint_v6();
    let material_signature = shared_domain_content_digest("material_signature", &plan.material)?;
    let physics_signature = shared_domain_content_digest(
        "physics_signature",
        &serde_json::json!({
            "enable_exchange": plan.enable_exchange,
            "enable_demag": plan.enable_demag,
            "external_field_a_per_m": plan.external_field,
            "gyromagnetic_ratio": plan.gyromagnetic_ratio,
            "damping": plan.material.damping,
            "operator": plan.operator,
            "demag_realization": resolved_demag_realization(plan)
                .map(|value| value.provenance_name()),
        }),
    )?;
    let boundary_signature = shared_domain_content_digest(
        "boundary_signature",
        &serde_json::json!({
            "spin_wave_bc": plan.spin_wave_bc,
            "air_box_config": plan.air_box_config,
            "periodic_node_pairs": plan.mesh.periodic_node_pairs,
            "periodic_boundary_pairs": plan.mesh.periodic_boundary_pairs,
        }),
    )?;
    let static_demag_signature = shared_domain_content_digest(
        "static_demag_signature",
        &serde_json::json!({
            "realization": resolved_demag_realization(plan)
                .map(|value| value.provenance_name()),
            "h_demag0_a_per_m": observables.demag_field,
            "phi0_a": phi0,
        }),
    )?;

    if let Some(source_artifact) = source_artifact {
        let compare = |label: &str, difference: Option<f64>, tolerance: f64| {
            let Some(difference) = difference else {
                return Err(RunError {
                    message: format!(
                        "equilibrium_{label}_comparison_failed: stored field shape does not match the requested mesh"
                    ),
                });
            };
            if !difference.is_finite() || difference > tolerance {
                return Err(RunError {
                    message: format!(
                        "equilibrium_{label}_comparison_failed: stored/recomputed maximum difference {difference:.3e} exceeds {tolerance:.3e}"
                    ),
                });
            }
            Ok(())
        };
        compare(
            "m0",
            max_vector_field_difference(&source_artifact.m0, equilibrium),
            1.0e-12,
        )?;
        compare(
            "h_eff0",
            max_vector_field_difference(&source_artifact.h_eff0, &observables.effective_field),
            1.0e-8,
        )?;
        compare(
            "h_demag0",
            max_vector_field_difference(&source_artifact.h_demag0, &observables.demag_field),
            1.0e-8,
        )?;
        compare(
            "phi0",
            max_scalar_field_difference(&source_artifact.phi0, &phi0),
            1.0e-10,
        )?;
        for (label, expected, actual) in [
            (
                "mesh_hash",
                &mesh_signature,
                &source_artifact.mesh_signature,
            ),
            (
                "material_hash",
                &material_signature,
                &source_artifact.material_signature,
            ),
            (
                "physics_hash",
                &physics_signature,
                &source_artifact.physics_signature,
            ),
            (
                "boundary_hash",
                &boundary_signature,
                &source_artifact.boundary_signature,
            ),
            (
                "static_demag_hash",
                &static_demag_signature,
                &source_artifact.static_demag_signature,
            ),
        ] {
            if expected != actual {
                return Err(RunError {
                    message: format!(
                        "equilibrium_{label}_mismatch: stored '{}' does not match recomputed '{}'",
                        actual, expected
                    ),
                });
            }
        }
    }

    let periodic_certificate = plan
        .mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            plan.material.ms_field.as_deref(),
            plan.material.a_field.as_deref(),
        )
        .map_err(|errors| RunError {
            message: format!(
                "shared-domain modal equilibrium requires periodic_mesh_certificate.v6: {}",
                errors.join("; ")
            ),
        })?;
    if periodic_certificate.schema_version != "periodic_mesh_certificate.v6"
        || periodic_certificate.certificate_status != "accepted"
    {
        return Err(RunError {
            message:
                "shared-domain modal equilibrium requires an accepted periodic_mesh_certificate.v6"
                    .to_string(),
        });
    }
    let (scalar_classes, scalar_class_count, magnetic_classes, magnetic_class_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    let (periodic_certificate_map_binding, periodic_certificate_map_binding_digest) =
        build_modal_certificate_map_binding(
            plan,
            topology,
            &periodic_certificate,
            &scalar_classes,
            scalar_class_count,
            &magnetic_classes,
            magnetic_class_count,
        )?;
    let periodic_certificate_payload =
        serde_json::to_value(&periodic_certificate).map_err(|error| RunError {
            message: format!(
                "failed to serialize periodic_mesh_certificate.v6 for equilibrium handoff: {error}"
            ),
        })?;
    let periodic_certificate_content_sha256 =
        shared_domain_content_digest("periodic_mesh_certificate", &periodic_certificate_payload)?;
    let periodic_certificate_id = format!(
        "periodic_mesh_certificate.v6:{}",
        periodic_certificate_content_sha256
            .strip_prefix("sha256:")
            .unwrap_or(&periodic_certificate_content_sha256)
    );
    let periodic_certificate_json = serde_json::json!({
        "schema_version": "periodic_mesh_certificate.v6",
        "certificate_id": periodic_certificate_id,
        "content_sha256": periodic_certificate_content_sha256,
        "certificate": periodic_certificate_payload,
        "modal_equivalence_map_binding": periodic_certificate_map_binding,
    });
    let periodic_mesh_certificate_digest =
        shared_domain_content_digest("periodic_mesh_certificate_v6", &periodic_certificate_json)?;
    let periodic_mesh_certificate_digest = if let Some(source_artifact) = source_artifact {
        let source_certificate = source_artifact
            .periodic_mesh_certificate
            .as_object()
            .ok_or_else(|| RunError {
                message: "equilibrium_periodic_certificate_missing_or_stale: certificate is not an object"
                    .to_string(),
            })?;
        for name in ["certificate_id", "content_sha256"] {
            if source_certificate.get(name) != periodic_certificate_json.get(name) {
                return Err(RunError {
                    message: format!(
                        "equilibrium_periodic_certificate_missing_or_stale: stored certificate '{}' does not match the current mesh certificate",
                        name
                    ),
                });
            }
        }
        if source_certificate.get("modal_equivalence_map_binding")
            != periodic_certificate_json.get("modal_equivalence_map_binding")
        {
            return Err(RunError {
                message:
                    "equilibrium_periodic_certificate_missing_or_stale: modal equivalence map binding does not match the current certificate"
                        .to_string(),
            });
        }
        source_certificate
            .get("content_sha256")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| RunError {
                message: "equilibrium_periodic_certificate_missing_or_stale: stored certificate hash is missing"
                    .to_string(),
            })?
            .to_string()
    } else {
        periodic_mesh_certificate_digest
    };

    let max_m0_norm_error = equilibrium
        .iter()
        .zip(topology.magnetic_node_volumes.iter())
        .filter(|(_, volume)| **volume > 0.0)
        .map(|(m, _)| (vector_norm(*m) - 1.0).abs())
        .fold(0.0, f64::max);
    let max_m0_cross_h_eff0_relative =
        observables.max_torque_Apm / observables.max_effective_field_amplitude.max(1.0);
    if !max_m0_norm_error.is_finite()
        || !max_m0_cross_h_eff0_relative.is_finite()
        || max_m0_norm_error > 1.0e-8
    {
        return Err(RunError {
            message: format!(
                "shared-domain modal equilibrium failed representation-integrity validation (m0_norm={max_m0_norm_error:.3e}, torque={max_m0_cross_h_eff0_relative:.3e})"
            ),
        });
    }

    let (
        equilibrium_artifact,
        equilibrium_artifact_digest,
        artifact_h_eff0,
        artifact_h_demag0,
        artifact_phi0,
        artifact_phi0_requirement,
        artifact_field_source,
    ) = if let Some(source_artifact) = source_artifact {
        (
            source_artifact.value.clone(),
            source_artifact.content_sha256.clone(),
            serde_json::json!(source_artifact.h_eff0),
            serde_json::json!(source_artifact.h_demag0),
            serde_json::json!(source_artifact.phi0),
            serde_json::json!(source_artifact.phi0_requirement),
            "stored_verified",
        )
    } else {
        let source_relax_handoff = source_relax_handoff.ok_or_else(|| {
            RunError {
                message: "equilibrium_artifact_v7_uncertified: accepted relaxation completion evidence is required"
                    .to_string(),
            }
        })?;
        let mut acceptance_certificate = source_relax_handoff.acceptance_json();
        acceptance_certificate
            .as_object_mut()
            .expect("accepted equilibrium criterion serializes as an object")
            .insert(
                "completion_sha256".to_string(),
                serde_json::json!(source_relax_handoff.completion_sha256),
            );
        let mut artifact = serde_json::json!({
            "schema_version": "equilibrium_artifact.v7",
            "accepted_for_linearization": true,
            "acceptance_certificate": acceptance_certificate,
            "completion_sha256": source_relax_handoff.completion_sha256,
            "external_field_a_per_m": plan.external_field,
            "m0": equilibrium,
            "h_eff0_a_per_m": observables.effective_field,
            "h_demag0_a_per_m": observables.demag_field,
            "phi0_requirement": "required_for_restart_or_provenance",
            "phi0_a": phi0,
            "mesh_signature": mesh_signature,
            "material_signature": material_signature,
            "physics_signature": physics_signature,
            "boundary_signature": boundary_signature,
            "static_demag_signature": static_demag_signature,
            "observables": {
                "max_torque_Apm": observables.max_torque_Apm,
                "max_torque_T": observables.max_torque_Apm * MU0,
                "max_torque_relative": max_m0_cross_h_eff0_relative,
            },
            "representation_integrity": {
                "m0_norm_tolerance": 1.0e-8,
            },
            "max_m0_norm_error": max_m0_norm_error,
            "max_m0_cross_h_eff0_relative": max_m0_cross_h_eff0_relative,
            "producer_run_id": source_relax_handoff.source_run_id,
            "demag_model": resolved_demag_realization(plan)
                .map(|value| value.model_name())
                .unwrap_or("none"),
            "periodic_mesh_certificate": periodic_certificate_json,
        });
        let digest = shared_domain_content_digest("equilibrium_artifact_v7", &artifact)?;
        if let Some(object) = artifact.as_object_mut() {
            object.insert("content_sha256".to_string(), serde_json::json!(digest));
            object.insert(
                "equilibrium_id".to_string(),
                serde_json::json!(format!(
                    "equilibrium_artifact.v7:{}",
                    digest.strip_prefix("sha256:").unwrap_or(&digest)
                )),
            );
        }
        (
            artifact,
            digest,
            serde_json::json!(observables.effective_field),
            serde_json::json!(observables.demag_field),
            serde_json::json!(phi0),
            serde_json::json!("required_for_restart_or_provenance"),
            "certified_native_relax_handoff",
        )
    };

    let required_artifact_string = |name: &str| -> Result<String, RunError> {
        equilibrium_artifact
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| RunError {
                message: format!(
                    "accepted equilibrium artifact is missing required identity field '{name}'"
                ),
            })
    };
    let equilibrium_id = source_artifact
        .map(|artifact| artifact.equilibrium_id.clone())
        .unwrap_or(required_artifact_string("equilibrium_id")?);
    let producer_run_id = source_artifact
        .map(|artifact| artifact.producer_run_id.clone())
        .unwrap_or(required_artifact_string("producer_run_id")?);
    let equilibrium_content_sha256 = required_artifact_string("content_sha256")?;
    let demag_model = source_artifact
        .map(|artifact| artifact.demag_model.clone())
        .or_else(|| {
            equilibrium_artifact
                .get("demag_model")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            resolved_demag_realization(plan)
                .map(|value| value.model_name().to_string())
                .unwrap_or_else(|| "none".to_string())
        });
    let m0_norm_tolerance = source_artifact
        .map(|artifact| artifact.m0_norm_tolerance)
        .unwrap_or(1.0e-8);
    let (acceptance_certificate, acceptance_certificate_sha256) = if let Some(artifact) =
        source_artifact
    {
        (
            artifact.acceptance_certificate.clone(),
            artifact.completion_sha256.clone(),
        )
    } else {
        let handoff = source_relax_handoff.ok_or_else(|| RunError {
                message: "equilibrium_artifact_v7_uncertified: accepted relaxation completion evidence is required"
                    .to_string(),
            })?;
        (
            handoff.acceptance.clone(),
            handoff.completion_sha256.clone(),
        )
    };
    if !is_sha256_digest(&acceptance_certificate_sha256) {
        return Err(RunError {
            message: "equilibrium_acceptance_certificate_digest_invalid".to_string(),
        });
    }

    let operator_m0 = extend_equilibrium_m0_to_air_nodes(topology, equilibrium);
    let mut linearization_state = serde_json::json!({
        "schema_version": "LinearizationState.v6",
        "source_equilibrium_artifact": equilibrium_artifact_digest,
        "source_equilibrium_id": equilibrium_id,
        "operator_dictionary": "FrequencyOperatorDictionary.v1",
        "accepted_for_frequency_operator": true,
        "external_field_a_per_m": plan.external_field,
        "m0": operator_m0,
        "m0_air_extension_policy": "fixed_unit_z_on_nonmagnetic_nodes_v1",
        "h_eff0_a_per_m": artifact_h_eff0,
        "h_demag0_a_per_m": artifact_h_demag0,
        "phi0_requirement": artifact_phi0_requirement,
        "phi0_a": artifact_phi0,
        "mesh_signature": mesh_signature,
        "material_signature": material_signature,
        "physics_signature": physics_signature,
        "boundary_signature": boundary_signature,
        "static_demag_signature": static_demag_signature,
        "periodic_mesh_certificate": periodic_mesh_certificate_digest,
        "periodic_modal_equivalence_map_binding": {
            "schema_version": "periodic_modal_equivalence_map_binding.v1",
            "content_sha256": periodic_certificate_map_binding_digest,
            "binding": periodic_certificate_json
                .get("modal_equivalence_map_binding")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        },
        "static_field_provenance": {
            "field_source": artifact_field_source,
            "comparison": if source_artifact.is_some() {
                "stored_vs_recomputed_passed"
            } else {
                "recomputed_from_equilibrium"
            },
        },
        "tangent_frame_policy": "orthonormal_right_handed_m0_v1",
        "equilibrium_acceptance_certificate": acceptance_certificate.clone(),
        "equilibrium_acceptance_certificate_sha256": acceptance_certificate_sha256.clone(),
        "acceptance": {
            "max_m0_norm_error": max_m0_norm_error,
            "max_m0_cross_h_eff0_relative": max_m0_cross_h_eff0_relative,
            "m0_norm_tolerance": m0_norm_tolerance,
        },
        "producer_run_id": producer_run_id,
        "demag_model": demag_model,
    });
    let linearization_state_digest =
        shared_domain_content_digest("linearization_state_v6", &linearization_state)?;
    if let Some(object) = linearization_state.as_object_mut() {
        object.insert(
            "content_sha256".to_string(),
            serde_json::json!(linearization_state_digest),
        );
        object.insert(
            "linearization_state_id".to_string(),
            serde_json::json!(format!(
                "LinearizationState.v6:{}",
                linearization_state_digest
                    .strip_prefix("sha256:")
                    .unwrap_or(&linearization_state_digest)
            )),
        );
    }

    let (linearization_m0, linearization_h_eff0, linearization_h_demag0) = source_artifact
        .map(|artifact| {
            (
                extend_equilibrium_m0_to_air_nodes(topology, &artifact.m0),
                artifact.h_eff0.clone(),
                artifact.h_demag0.clone(),
            )
        })
        .unwrap_or_else(|| {
            (
                operator_m0,
                observables.effective_field.clone(),
                observables.demag_field.clone(),
            )
        });

    Ok(SharedDomainLinearizationState {
        equilibrium_artifact,
        linearization_state,
        equilibrium_m0: linearization_m0,
        h_eff0: linearization_h_eff0,
        h_demag0: linearization_h_demag0,
        phi0,
        equilibrium_id,
        mesh_snapshot_id: mesh_signature,
        material_snapshot_id: material_signature,
        physics_snapshot_id: physics_signature,
        boundary_snapshot_id: boundary_signature,
        producer_run_id,
        equilibrium_content_sha256,
        demag_model,
        m0_norm_tolerance,
        acceptance_certificate,
        acceptance_certificate_sha256,
        equilibrium_artifact_digest,
        linearization_state_digest,
        periodic_mesh_certificate_digest,
        periodic_mesh_certificate_map_binding_digest: periodic_certificate_map_binding_digest,
    })
}

fn build_native_shared_domain_modal_problem<'a>(
    plan: &'a FemEigenPlanIR,
    topology: &MeshTopology,
    equilibrium: &[Vector3],
    observables: &EffectiveFieldObservables,
    linearization_state: Option<&SharedDomainLinearizationState>,
    bias_field_sample_index: usize,
) -> Result<native_fem::NativeModalEigenSharedDomainProblem<'a>, RunError> {
    if !plan.enable_demag || !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        return Err(RunError {
            message: "shared-domain modal payload requires full2x2 dynamic demag".to_string(),
        });
    }
    if plan.material.ms_field.is_some() {
        return Err(RunError {
            message: "shared-domain modal production scope currently requires uniform material Ms"
                .to_string(),
        });
    }
    validate_shared_domain_modal_scope(plan, topology, equilibrium, observables)?;
    let has_magnetic_region = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| is_magnetic);
    let has_airbox_region = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| !is_magnetic);
    if topology.magnetic_element_mask.len() != topology.n_elements
        || !has_magnetic_region
        || !has_airbox_region
    {
        return Err(RunError {
            message: "k0_poisson_airbox_requires_explicit_region_markers: shared-domain K0 requires distinct magnetic and airbox element markers".to_string(),
        });
    }
    let config = plan.air_box_config.as_ref().ok_or_else(|| RunError {
        message: "shared-domain modal production scope requires air_box_config".to_string(),
    })?;
    let pair_stats = periodic_domain_pair_stats(&plan.mesh)?;
    if pair_stats.magnetic_pair_count == 0 || pair_stats.airbox_pair_count == 0 {
        return Err(RunError {
            message:
                "shared-domain modal production scope requires magnetic and airbox periodic pairs"
                    .to_string(),
        });
    }
    let boundary_kind = match config.bc_kind.as_deref() {
        Some("dirichlet") => "dirichlet",
        Some("pure_neumann") => "pure_neumann",
        Some("robin") | None => "robin",
        Some(other) => {
            return Err(RunError {
                message: format!("unsupported shared-domain modal airbox boundary kind '{other}'"),
            });
        }
    };
    let robin_beta = if boundary_kind == "robin" {
        shared_domain_robin_beta_m(plan)?.ok_or_else(|| RunError {
            message: "shared-domain modal Robin beta is unavailable".to_string(),
        })?
    } else {
        0.0
    };
    let (scalar_classes, scalar_count, magnetic_classes, magnetic_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    let mesh_certificate = plan
        .mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            plan.material.ms_field.as_deref(),
            plan.material.a_field.as_deref(),
        )
        .map_err(|errors| RunError {
            message: format!(
                "shared-domain modal production requires an accepted periodic_mesh_certificate.v6: {}",
                errors.join("; ")
            ),
        })?;
    if mesh_certificate.schema_version != "periodic_mesh_certificate.v6"
        || mesh_certificate.certificate_status != "accepted"
    {
        return Err(RunError {
            message:
                "shared-domain modal production requires an accepted periodic_mesh_certificate.v6"
                    .to_string(),
        });
    }
    let (_map_binding, map_binding_digest) = build_modal_certificate_map_binding(
        plan,
        topology,
        &mesh_certificate,
        &scalar_classes,
        scalar_count,
        &magnetic_classes,
        magnetic_count,
    )?;
    let linearization_state = linearization_state.ok_or_else(|| RunError {
        message: "shared-domain modal descriptor requires an accepted linearization state"
            .to_string(),
    })?;
    if linearization_state.periodic_mesh_certificate_map_binding_digest != map_binding_digest {
        return Err(RunError {
            message: "shared-domain modal periodic certificate map binding is stale or mismatched"
                .to_string(),
        });
    }
    let mesh_certificate_digest = linearization_state.periodic_mesh_certificate_digest.clone();
    let ms_values = plan.material.ms_field.clone().unwrap_or_default();
    if !ms_values.is_empty() && ms_values.len() != topology.n_nodes {
        return Err(RunError {
            message: "shared-domain modal nodal Ms field does not match the mesh".to_string(),
        });
    }
    let pack_full_field = |field: &[Vector3], label: &str| -> Result<Vec<f64>, RunError> {
        if field.len() != topology.n_nodes {
            return Err(RunError {
                message: format!(
                    "shared-domain native {label} field length {} does not match mesh node count {}",
                    field.len(),
                    topology.n_nodes
                ),
            });
        }
        Ok(field.iter().flatten().copied().collect())
    };
    let linearization_m0_xyz = pack_full_field(&linearization_state.equilibrium_m0, "m0")?;
    let linearization_h_eff0_xyz = pack_full_field(&linearization_state.h_eff0, "h_eff0")?;
    let linearization_h_demag0_xyz = pack_full_field(&linearization_state.h_demag0, "h_demag0")?;
    let external_field_h_ext0_xyz = pack_full_field(&observables.external_field, "h_ext0")?;
    if linearization_state.phi0.len() != topology.n_nodes {
        return Err(RunError {
            message: format!(
                "shared-domain native phi0 length {} does not match mesh node count {}",
                linearization_state.phi0.len(),
                topology.n_nodes
            ),
        });
    }
    let tangent_frame_xyz = tangent_bases(&linearization_state.equilibrium_m0)
        .into_iter()
        .flat_map(|(e1, e2)| e1.into_iter().chain(e2))
        .collect::<Vec<_>>();
    let alpha_per_node = match plan.material.alpha_field.as_ref() {
        Some(alpha) if alpha.len() == topology.n_nodes => alpha.clone(),
        Some(alpha) => {
            return Err(RunError {
                message: format!(
                    "shared-domain native alpha field length {} does not match mesh node count {}",
                    alpha.len(),
                    topology.n_nodes
                ),
            });
        }
        None => vec![plan.material.damping; topology.n_nodes],
    };
    let demag_model = resolved_demag_realization(plan)
        .filter(|realization| realization.is_poisson())
        .ok_or_else(|| RunError {
            message: "shared-domain modal descriptor requires a real Poisson-airbox demag provider"
                .to_string(),
        })?
        .model_name()
        .to_string();
    let exchange_term_digest = plan
        .enable_exchange
        .then(|| {
            shared_domain_content_digest(
                "linearization_exchange_term",
                &(
                    plan.material.exchange_stiffness,
                    plan.material.saturation_magnetisation,
                ),
            )
        })
        .transpose()?;
    let field_term_digest = Some(shared_domain_content_digest(
        "linearization_field_term",
        &external_field_h_ext0_xyz,
    )?);
    let demag_term_digest = Some(shared_domain_content_digest(
        "linearization_demag_term",
        &(
            demag_model.as_str(),
            linearization_h_demag0_xyz.as_slice(),
            linearization_state.phi0.as_slice(),
        ),
    )?);
    let term_presence_mask = (if plan.enable_exchange {
        MODAL_LINEARIZATION_TERM_EXCHANGE
    } else {
        0
    }) | MODAL_LINEARIZATION_TERM_FIELD
        | MODAL_LINEARIZATION_TERM_DEMAG;
    let operator_input_digest = shared_domain_content_digest(
        "linearization_operator_input",
        &(
            linearization_state.linearization_state_digest.as_str(),
            linearization_state.equilibrium_artifact_digest.as_str(),
            term_presence_mask,
            exchange_term_digest.as_deref(),
            field_term_digest.as_deref(),
            demag_term_digest.as_deref(),
            tangent_frame_xyz.as_slice(),
            linearization_m0_xyz.as_slice(),
            linearization_h_eff0_xyz.as_slice(),
            external_field_h_ext0_xyz.as_slice(),
            alpha_per_node.as_slice(),
        ),
    )?;
    let certificate_binding_v6 = build_owned_modal_certificate_v6_binding(
        &plan.mesh,
        &mesh_certificate,
        &plan.mesh_parts,
        plan.material.ms_field.as_deref(),
        plan.material.a_field.as_deref(),
        &scalar_classes,
        scalar_count,
        &magnetic_classes,
        magnetic_count,
        boundary_kind,
        config.boundary_marker,
        robin_beta,
        bias_field_sample_index as u64,
        &external_field_h_ext0_xyz,
    )?;
    Ok(native_fem::NativeModalEigenSharedDomainProblem {
        mesh: &plan.mesh,
        equilibrium_m0_xyz: linearization_m0_xyz.clone(),
        linearization_m0_xyz,
        linearization_h_eff0_xyz,
        linearization_h_demag0_xyz,
        linearization_phi0: linearization_state.phi0.clone(),
        equilibrium_id: linearization_state.equilibrium_id.clone(),
        mesh_snapshot_id: linearization_state.mesh_snapshot_id.clone(),
        material_snapshot_id: linearization_state.material_snapshot_id.clone(),
        physics_snapshot_id: linearization_state.physics_snapshot_id.clone(),
        boundary_snapshot_id: linearization_state.boundary_snapshot_id.clone(),
        producer_run_id: linearization_state.producer_run_id.clone(),
        equilibrium_content_sha256: linearization_state.equilibrium_content_sha256.clone(),
        demag_model,
        m0_norm_tolerance: linearization_state.m0_norm_tolerance,
        acceptance_criterion: linearization_state.acceptance_certificate.criterion.clone(),
        acceptance_metric_kind: linearization_state
            .acceptance_certificate
            .metric_kind_name()
            .to_string(),
        acceptance_unit: linearization_state.acceptance_certificate.unit.clone(),
        acceptance_metric_value: linearization_state.acceptance_certificate.metric_value,
        acceptance_threshold: linearization_state.acceptance_certificate.threshold,
        acceptance_certificate_sha256: linearization_state.acceptance_certificate_sha256.clone(),
        saturation_magnetisation_a_per_m: ms_values,
        uniform_saturation_magnetisation_a_per_m: plan.material.saturation_magnetisation,
        gamma0_m_per_a_s: plan.gyromagnetic_ratio,
        tangent_frame_xyz,
        external_field_h_ext0_xyz,
        alpha_per_node,
        term_presence_mask,
        exchange_term_digest,
        field_term_digest,
        demag_term_digest,
        operator_input_digest: operator_input_digest.clone(),
        demag_provider_signature: Some(operator_input_digest),
        exchange_stiffness_j_per_m: plan
            .enable_exchange
            .then_some(plan.material.exchange_stiffness),
        scalar_reduced_node: scalar_classes,
        scalar_reduced_node_count: scalar_count,
        magnetic_reduced_node: magnetic_classes,
        magnetic_reduced_node_count: magnetic_count,
        magnetic_pair_count: pair_stats.magnetic_pair_count,
        airbox_pair_count: pair_stats.airbox_pair_count,
        boundary_kind: boundary_kind.to_string(),
        robin_beta,
        boundary_marker: config.boundary_marker,
        equilibrium_digest: linearization_state.equilibrium_artifact_digest.clone(),
        mesh_certificate_digest,
        mesh_certificate_schema: "periodic_mesh_certificate.v6".to_string(),
        mesh_certificate_map_binding_digest: certificate_binding_v6
            .shared_domain_map_binding_sha256
            .clone(),
        linearization_state_digest: linearization_state.linearization_state_digest.clone(),
        mesh_generation_identity: certificate_binding_v6.mesh_generation_identity.clone(),
        canonical_preimage: certificate_binding_v6.canonical_preimage.clone(),
        canonical_preimage_sha256: certificate_binding_v6.canonical_preimage_sha256.clone(),
        magnetic_class_digest_sha256: certificate_binding_v6.magnetic_class_digest_sha256.clone(),
        scalar_class_digest_sha256: certificate_binding_v6.scalar_class_digest_sha256.clone(),
        certificate_binding_status: MODAL_CERTIFICATE_BINDING_ACCEPTED,
        certificate_binding_reason: "none".to_string(),
        certificate_binding_v6,
        _marker: std::marker::PhantomData,
    })
}

fn validate_native_shared_domain_certificate_producer(
    plan: &FemEigenPlanIR,
) -> Result<(), RunError> {
    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("shared-domain v6 producer topology is invalid: {error}"),
    })?;
    let certificate = plan
        .mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            None,
            None,
            plan.material.ms_field.as_deref(),
            plan.material.a_field.as_deref(),
        )
        .map_err(|errors| RunError {
            message: format!(
                "shared-domain v6 producer certificate is unavailable: {}",
                errors.join("; ")
            ),
        })?;
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology)?;
    let config = plan
        .air_box_config
        .as_ref()
        .ok_or_else(|| modal_v6_error("airbox_config_missing"))?;
    let boundary_kind = match config.bc_kind.as_deref() {
        Some("dirichlet") => "dirichlet",
        Some("pure_neumann") => "pure_neumann",
        Some("robin") | None => "robin",
        Some(_) => return Err(modal_v6_error("airbox_boundary_kind_unsupported")),
    };
    let robin_beta = if boundary_kind == "robin" {
        shared_domain_robin_beta_m(plan)
            .map_err(|_| modal_v6_error("airbox_robin_gauge_invalid"))?
            .ok_or_else(|| modal_v6_error("airbox_robin_gauge_invalid"))?
    } else {
        0.0
    };
    let bias_field = plan.external_field.unwrap_or([0.0, 0.0, 0.0]);
    build_owned_modal_certificate_v6_binding(
        &plan.mesh,
        &certificate,
        &plan.mesh_parts,
        plan.material.ms_field.as_deref(),
        plan.material.a_field.as_deref(),
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        boundary_kind,
        config.boundary_marker,
        robin_beta,
        0,
        &bias_field,
    )?;
    Ok(())
}

// Aggregate producer gate. Native MFEM owns A_qq assembly; availability is
// true only when this concrete plan can materialize and validate the complete
// accepted v6 certificate binding that will cross the FFI boundary.
pub(crate) fn native_shared_domain_magnetic_assembly_available(plan: &FemEigenPlanIR) -> bool {
    validate_native_shared_domain_certificate_producer(plan).is_ok()
}

fn native_shared_domain_magnetic_assembly_error(plan: &FemEigenPlanIR) -> Option<String> {
    validate_native_shared_domain_certificate_producer(plan)
        .err()
        .map(|error| error.message)
}

fn shared_domain_k0_runtime_unavailable_error() -> RunError {
    RunError {
        message: format!(
            "{SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON}: {SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_DETAIL}"
        ),
    }
}

fn full_physical_magnetic_reduction_map(topology: &MeshTopology) -> ReductionMap {
    let active_nodes = topology
        .magnetic_node_volumes
        .iter()
        .enumerate()
        .filter_map(|(node, volume)| (*volume > 0.0).then_some(node))
        .collect::<Vec<_>>();
    let mut node_map = vec![None; topology.n_nodes];
    for (reduced, node) in active_nodes.iter().copied().enumerate() {
        node_map[node] = Some(reduced);
    }
    ReductionMap {
        active_nodes,
        node_map,
        node_phases: vec![Complex64::new(1.0, 0.0); topology.n_nodes],
        complex_reduction: false,
    }
}

fn validate_shared_domain_modal_scope(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    equilibrium: &[Vector3],
    observables: &EffectiveFieldObservables,
) -> Result<(), RunError> {
    if equilibrium.len() != topology.n_nodes {
        return Err(RunError {
            message: "shared-domain modal linearization equilibrium length does not match the mesh"
                .to_string(),
        });
    }
    if observables.max_effective_field_amplitude <= 0.0
        || !observables.max_effective_field_amplitude.is_finite()
        || !observables.max_torque_Apm.is_finite()
    {
        return Err(RunError {
            message: "shared-domain modal linearization requires finite effective-field and torque diagnostics"
                .to_string(),
        });
    }
    let mut magnetic_node_count = 0usize;
    for (node, (volume, magnetization)) in topology
        .magnetic_node_volumes
        .iter()
        .zip(equilibrium.iter())
        .enumerate()
    {
        if *volume <= 0.0 {
            continue;
        }
        magnetic_node_count += 1;
        let norm_error = (vector_norm(*magnetization) - 1.0).abs();
        if !norm_error.is_finite() || norm_error > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "shared-domain modal production scope requires normalized equilibrium (node {node} has norm error {norm_error:.3e})"
                ),
            });
        }
    }
    if magnetic_node_count == 0 {
        return Err(RunError {
            message: "shared-domain modal linearization requires at least one magnetic node"
                .to_string(),
        });
    }
    // A k=0 periodic reduction identifies paired magnetic nodes.  The static
    // equilibrium may be textured inside the unit cell (for example around an
    // antidot), but it must be periodic across every identified pair.
    for (pair_id, node_a, node_b) in &topology.periodic_node_pairs {
        let node_a = *node_a as usize;
        let node_b = *node_b as usize;
        if topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let a = equilibrium[node_a];
        let b = equilibrium[node_b];
        let mismatch = vector_norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
        if !mismatch.is_finite() || mismatch > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "shared-domain modal production scope requires periodic equilibrium across pair '{pair_id}' (nodes {node_a}/{node_b}, mismatch {mismatch:.3e})"
                ),
            });
        }
    }
    let unsupported_local_term = plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan.material.anisotropy_axis.is_some()
        || plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
        || plan.material.cubic_anisotropy_axis1.is_some()
        || plan.material.cubic_anisotropy_axis2.is_some()
        || plan.material.a_field.is_some()
        || plan.material.ku_field.is_some()
        || plan.material.ku2_field.is_some()
        || plan.material.kc1_field.is_some()
        || plan.material.kc2_field.is_some()
        || plan.material.kc3_field.is_some()
        || plan.material.dind_field.is_some()
        || plan.material.dbulk_field.is_some()
        || plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan.spin_wave_bc.surface_anisotropy_ks().is_some();
    if unsupported_local_term {
        return Err(RunError {
            message: "shared-domain modal production scope currently accepts exchange, Zeeman, and dynamic demag only; anisotropy and DMI tangent terms are not yet certified"
                .to_string(),
        });
    }
    Ok(())
}

impl OwnedModalEigenPoissonAirboxBlockProblem {
    fn borrowed(&self) -> native_fem::NativeModalEigenPoissonAirboxBlockProblem<'_> {
        native_fem::NativeModalEigenPoissonAirboxBlockProblem {
            q_dof_count: self.q_dof_count,
            phi_dof_count: self.phi_dof_count,
            a_qq_csr: self.a_qq_csr.view(),
            a_qphi_csr: self.a_qphi_csr.view(),
            a_phiq_csr: self.a_phiq_csr.view(),
            a_phiphi_csr: self.a_phiphi_csr.view(),
            b_qq_csr: self.b_qq_csr.view(),
            phi_mean_weights: &self.phi_mean_weights,
            target_frequency_hz: self.target_frequency_hz,
            expected_reference_frequency_hz: self.expected_reference_frequency_hz,
            // Task 6 owns transport of the certificate ID through the C ABI.
            // The existing ABI can nevertheless advertise only v6 material.
            periodic_mesh_certificate_schema: "periodic_mesh_certificate.v6",
            magnetic_pair_count: self.magnetic_pair_count,
            airbox_pair_count: self.airbox_pair_count,
            outer_boundary_kind: self.outer_boundary_kind,
            robin_beta: self.robin_beta,
            gauge_policy: self.gauge_policy,
            gauge_reason: self.gauge_reason,
            assembly_kind: self.assembly_kind,
            shift_invert_action: None,
        }
    }
}

fn build_pa_e4b_k0_kittel_poisson_airbox_payload(
    plan: &FemEigenPlanIR,
) -> Result<Option<OwnedModalEigenPoissonAirboxBlockProblem>, RunError> {
    if !k0_kittel_periodic_airbox_validation_requested(plan) {
        return Ok(None);
    }
    let validation = plan.k0_kittel_validation.as_ref().ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload requires K0-3 validation metadata".to_string(),
    })?;
    let sample = validation.samples.first().ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload requires at least one K0-3 field sample"
            .to_string(),
    })?;
    let h0 = plan
        .external_field
        .map(vector_norm)
        .or_else(|| {
            plan.bias_field_samples
                .first()
                .map(|sample| vector_norm(sample.field_a_per_m))
        })
        // This fallback is retained only for the standalone analytical Kittel
        // oracle builder.  It is never used by execute_cpu_fem_eigen or
        // execute_gpu_fem_eigen, which require BiasFieldSweepIR for physical
        // field scans.
        .unwrap_or_else(|| vector_norm(sample.bias_field));
    let m_eff = validation
        .material
        .effective_magnetisation
        .ok_or_else(|| RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires effective_magnetisation"
                .to_string(),
        })?;
    if !(h0 > 0.0) || !(m_eff > 0.0) {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive H0 and M_eff".to_string(),
        });
    }
    let pair_stats = periodic_domain_pair_stats(&plan.mesh)?;
    let magnetic_pair_count = pair_stats.magnetic_pair_count;
    let airbox_pair_count = pair_stats.airbox_pair_count;
    if magnetic_pair_count == 0 || airbox_pair_count == 0 {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive magnetic and airbox periodic pair counts".to_string(),
        });
    }
    let airbox_size_m = pa_e4b_airbox_size_m(plan)?;
    let omega0 = plan.gyromagnetic_ratio * h0;
    let demag_delta = plan.gyromagnetic_ratio * m_eff;
    let q_dof_count = magnetic_pair_count.checked_mul(2).ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload q DOF count overflow".to_string(),
    })?;
    let phi_dof_count = airbox_pair_count.checked_mul(2).ok_or_else(|| RunError {
        message: "PA-E4b periodic_airbox_k0 payload phi DOF count overflow".to_string(),
    })?;
    if q_dof_count > 128 || phi_dof_count > 128 {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 validation payload currently supports at most 128 q and 128 phi DOF".to_string(),
        });
    }
    let q_len = usize::try_from(q_dof_count).map_err(|_| RunError {
        message: "PA-E4b periodic_airbox_k0 payload q DOF count overflow".to_string(),
    })?;
    let phi_len = usize::try_from(phi_dof_count).map_err(|_| RunError {
        message: "PA-E4b periodic_airbox_k0 payload phi DOF count overflow".to_string(),
    })?;
    let mut a_qq = vec![0.0; q_len * q_len];
    let mut a_qphi = vec![0.0; q_len * phi_len];
    let mut a_phiq = vec![0.0; phi_len * q_len];
    let mut a_phiphi = vec![0.0; phi_len * phi_len];
    let mut b_qq = vec![0.0; q_len * q_len];
    let total_airbox_pair_length = pair_stats.airbox_pair_lengths_m.iter().sum::<f64>();
    if !(total_airbox_pair_length.is_finite() && total_airbox_pair_length > 0.0) {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive total airbox periodic pair length".to_string(),
        });
    }
    let reference_airbox_pair_length = airbox_size_m;
    for magnetic_pair in 0..usize::try_from(magnetic_pair_count).map_err(|_| RunError {
        message: "PA-E4b periodic_airbox_k0 payload magnetic pair count overflow".to_string(),
    })? {
        let q0 = 2 * magnetic_pair;
        let q1 = q0 + 1;
        let mass = pair_stats.magnetic_pair_masses[magnetic_pair];
        a_qq[q0 * q_len + q1] = -omega0 * mass;
        a_qq[q1 * q_len + q0] = omega0 * mass;
        b_qq[q0 * q_len + q0] = mass;
        b_qq[q1 * q_len + q1] = mass;

        let phi0 = (2 * magnetic_pair) % phi_len;
        let phi1 = (phi0 + 1) % phi_len;
        let airbox_pair = magnetic_pair % pair_stats.airbox_pair_lengths_m.len();
        let poisson_conductance =
            reference_airbox_pair_length / pair_stats.airbox_pair_lengths_m[airbox_pair];
        let coupling_shape = poisson_conductance.sqrt();
        a_qphi[q0 * phi_len + phi0] -= demag_delta * mass * coupling_shape;
        a_qphi[q0 * phi_len + phi1] += demag_delta * mass * coupling_shape;
        a_phiq[phi0 * q_len + q1] -= coupling_shape;
        a_phiq[phi1 * q_len + q1] += coupling_shape;
    }
    if phi_len == 1 {
        a_phiphi[0] = 1.0;
    } else {
        let edge_count = if phi_len == 2 { 1 } else { phi_len };
        for index in 0..edge_count {
            let next = (index + 1) % phi_len;
            let airbox_pair = (index / 2).min(pair_stats.airbox_pair_lengths_m.len() - 1);
            let conductance =
                reference_airbox_pair_length / pair_stats.airbox_pair_lengths_m[airbox_pair];
            a_phiphi[index * phi_len + index] += conductance;
            a_phiphi[next * phi_len + next] += conductance;
            a_phiphi[index * phi_len + next] -= conductance;
            a_phiphi[next * phi_len + index] -= conductance;
        }
    }
    let mut phi_mean_weights = Vec::with_capacity(phi_len);
    for pair_length in &pair_stats.airbox_pair_lengths_m {
        let weight = *pair_length / (2.0 * total_airbox_pair_length);
        phi_mean_weights.push(weight);
        phi_mean_weights.push(weight);
    }
    Ok(Some(OwnedModalEigenPoissonAirboxBlockProblem {
        q_dof_count,
        phi_dof_count,
        a_qq_csr: OwnedModalEigenCsrMatrix::from_dense(q_dof_count, q_dof_count, &a_qq)?,
        a_qphi_csr: OwnedModalEigenCsrMatrix::from_dense(q_dof_count, phi_dof_count, &a_qphi)?,
        a_phiq_csr: OwnedModalEigenCsrMatrix::from_dense(phi_dof_count, q_dof_count, &a_phiq)?,
        a_phiphi_csr: OwnedModalEigenCsrMatrix::from_dense(
            phi_dof_count,
            phi_dof_count,
            &a_phiphi,
        )?,
        b_qq_csr: OwnedModalEigenCsrMatrix::from_dense(q_dof_count, q_dof_count, &b_qq)?,
        phi_mean_weights,
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        // Kittel is an independent postsolve validation oracle. Keep the
        // legacy ABI slot empty so it cannot influence selection or status.
        expected_reference_frequency_hz: 0.0,
        magnetic_pair_count,
        airbox_pair_count,
        outer_boundary_kind: "pure_neumann",
        robin_beta: 0.0,
        gauge_policy: "mean_zero_augmented",
        gauge_reason: "pure_neumann_nullspace",
        assembly_kind: "synthetic_algebraic_oracle",
    }))
}

pub(crate) fn native_cpu_modal_window_rejection_reason(
    plan: &FemEigenPlanIR,
) -> Option<&'static str> {
    if native_cpu_modal_window_enabled(plan) {
        return None;
    }
    if shared_domain_k0_modal_requested(plan) {
        return Some("production_cpu_modal_periodic_airbox_k0_payload_missing");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && matches!(
            plan.damping_policy,
            fullmag_ir::EigenDampingPolicyIR::Ignore
        )
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && k_sampling_contains_nonzero(plan.k_sampling.as_ref())
    {
        if plan.operator.include_demag {
            return Some("production_cpu_modal_dynamic_demag_k_operator_missing");
        }
        return Some("production_cpu_modal_nonzero_k_floquet_operator_missing");
    }
    None
}

pub(crate) fn native_cpu_modal_window_rejection_scope(reason: &str) -> &'static str {
    if reason == "production_cpu_modal_dynamic_demag_k_operator_missing" {
        return "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag";
    }
    "selected_spectrum_nonzero_k_floquet_modal"
}

pub(crate) fn insert_native_cpu_modal_window_rejection_contract(
    object: &mut serde_json::Map<String, serde_json::Value>,
    reason: &str,
) {
    let required_operator_contract =
        if reason == "production_cpu_modal_dynamic_demag_k_operator_missing" {
            "bloch_floquet_tangent_operator_with_dynamic_demag_k"
        } else {
            "bloch_floquet_tangent_operator_with_periodic_pairs"
        };
    object.insert(
        "required_operator_contract".to_string(),
        serde_json::json!(required_operator_contract),
    );
    object.insert(
        "required_operator_payload_kind".to_string(),
        serde_json::json!("bloch_floquet_tangent_operator"),
    );
    if reason == "production_cpu_modal_dynamic_demag_k_operator_missing" {
        object.insert(
            "required_demag_payload_kind".to_string(),
            serde_json::json!("dynamic_demag_k_operator"),
        );
        object.insert(
            "dynamic_demag_operator_source".to_string(),
            serde_json::json!("missing_numeric_fem_demag_k"),
        );
    }
    if reason == "production_cpu_modal_periodic_airbox_k0_payload_missing" {
        object.insert(
            "runtime_capability_status".to_string(),
            serde_json::json!("unsupported"),
        );
        object.insert(
            "runtime_capability_reason".to_string(),
            serde_json::json!(SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON),
        );
        object.insert(
            "native_shared_domain_magnetic_assembly_available".to_string(),
            serde_json::json!(false),
        );
        object.insert(
            "certificate_binding_v6_producer_available".to_string(),
            serde_json::json!(false),
        );
    }
    object.insert(
        "modal_periodic_pair_contract_available".to_string(),
        serde_json::json!(false),
    );
}

fn validate_eigen_equilibrium_certificate(
    plan: &FemEigenPlanIR,
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
) -> Result<(), RunError> {
    match &plan.equilibrium {
        EquilibriumSourceIR::RelaxedInitialState if source_relax_handoff.is_none() => {
            return Err(RunError {
                message: "accepted relaxation handoff is required before FEM eigensolve"
                    .to_string(),
            });
        }
        EquilibriumSourceIR::Provided
            if source_relax_handoff.is_none() && expected_handoff.is_none() =>
        {
            return Err(RunError {
                message: "uncertified_provided_equilibrium: provide equilibrium_artifact.v7 or an accepted relaxation handoff"
                    .to_string(),
            });
        }
        _ => {}
    }
    if let Some(handoff) = expected_handoff {
        if !matches!(plan.equilibrium, EquilibriumSourceIR::Provided) {
            return Err(RunError {
                message: "relax_to_eigen_handoff_requires_provided_equilibrium_target".to_string(),
            });
        }
        handoff.validate_target_plan(plan)?;
    }
    Ok(())
}

/// Explicit validation-only adapter for unit fixtures that need to exercise
/// post-certificate solver code with a raw `Provided` vector. Production code
/// cannot name this function and must supply a real artifact or relax handoff.
#[cfg(test)]
fn validation_only_raw_provided_fixture_handoff(
    plan: &FemEigenPlanIR,
) -> Result<AcceptedFemEigenEquilibriumHandoff, RunError> {
    if !matches!(plan.equilibrium, EquilibriumSourceIR::Provided) {
        return Err(RunError {
            message: "validation_only_raw_provided_requires_provided_equilibrium".to_string(),
        });
    }
    AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
        plan,
        plan.equilibrium_magnetization.clone(),
        sha256_text("validation-only raw provided equilibrium artifact"),
        sha256_text("validation-only raw provided linearization state"),
    )
}

fn execute_fem_eigen_inner(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    try_gpu: bool,
    use_native_modal_production: bool,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    artifact_sample_index: usize,
    initial_magnetization_override: Option<&[Vector3]>,
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
) -> Result<ExecutedRun, RunError> {
    validate_eigen_equilibrium_certificate(plan, expected_handoff, source_relax_handoff)?;
    if plan.precision != fullmag_ir::ExecutionPrecision::Double {
        return Err(RunError {
            message: if try_gpu {
                "execution_precision='single' is not executable in the FEM eigen GPU path; single-precision GPU eigensolve is not yet implemented"
            } else {
                "execution_precision='single' is not executable in the FEM eigen CPU path; use 'double'"
            }
            .to_string(),
        });
    }
    if use_native_modal_production
        && shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    reject_unsupported_floquet_dynamic_demag(&plan.spin_wave_bc, plan.operator.include_demag)?;
    let num_modes = plan.count as usize;

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "materializing_equilibrium",
            phase_index: 1,
            phase_count: 5,
            percent: 5.0,
            solver_kind: solver_kind_label(plan),
            active_nodes: 0,
            effective_dof: 0,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: 0,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    let initial_magnetization = initial_magnetization_override
        .map(<[Vector3]>::to_vec)
        .unwrap_or_else(|| plan.equilibrium_magnetization.clone());
    let (problem, equilibrium, relaxation_steps, observables, source_artifact) =
        materialize_equilibrium(plan, &initial_magnetization, source_relax_handoff)?;
    let topology = &problem.topology;
    let mut solver_kind = solver_kind_label(plan);
    let reduction = build_reduction_map(topology, &plan.spin_wave_bc, plan.k_sampling.as_ref())?;
    if reduction.active_nodes.is_empty() {
        return Err(RunError {
            message: "FEM eigen solver found no magnetically active nodes".to_string(),
        });
    }
    let complex_reduction = reduction.complex_reduction;

    // Warn about dense O(n³) scaling for large problems (transitional path).
    let active_n = reduction.active_nodes.len();
    let is_full_2x2 = matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2);
    let effective_dof = if is_full_2x2 { 2 * active_n } else { active_n };
    let use_sparse = effective_dof > SPARSE_EIGEN_THRESHOLD && !try_gpu && !complex_reduction;
    if effective_dof > 3000 && !use_sparse {
        eprintln!(
            "warning: FEM eigen dense solver has {} effective DOF ({} active nodes, {}) — O(n³) scaling; \
             consider reducing mesh size or awaiting future sparse/Krylov eigensolver",
            effective_dof,
            active_n,
            if is_full_2x2 { "full 2×2" } else { "scalar" }
        );
    }
    if use_sparse {
        eprintln!(
            "info: FEM eigen using sparse LOBPCG solver for {} effective DOF ({} active nodes, {})",
            effective_dof,
            active_n,
            if is_full_2x2 { "full 2×2" } else { "scalar" }
        );
    }

    let progress_solver_kind = if use_sparse {
        "cpu_sparse_lobpcg"
    } else {
        solver_kind_label(plan)
    };
    let dense_warning = (effective_dof > 3000 && !use_sparse)
        .then_some("dense_o_n3_eigensolve_without_iteration_progress");
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "assembling_operator",
            phase_index: 2,
            phase_count: 5,
            percent: 20.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: 0,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: dense_warning,
        },
    )?;

    let bases = tangent_bases(&equilibrium);
    let mut dense_orthogonality = None;

    let real_eigenpairs = if complex_reduction {
        Vec::new()
    } else if is_full_2x2 {
        if use_native_modal_production && shared_domain_k0_modal_requested(plan) {
            return execute_native_modal_window(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &problem,
                source_artifact.as_ref(),
                source_relax_handoff,
                topology,
                &reduction,
                &bases,
                None,
                progress,
                active_n,
                effective_dof,
                artifact_sample_index,
                if try_gpu {
                    native_fem::NativeModalExecutionTarget::ProductionGpu
                } else {
                    native_fem::NativeModalExecutionTarget::ProductionCpu
                },
                expected_handoff,
            );
        }
        let (stiffness, mass) = assemble_full_2x2_operator_real(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
            &bases,
        );
        if use_native_modal_production {
            return execute_native_modal_window(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &problem,
                source_artifact.as_ref(),
                source_relax_handoff,
                topology,
                &reduction,
                &bases,
                Some((&stiffness, &mass)),
                progress,
                active_n,
                effective_dof,
                artifact_sample_index,
                if try_gpu {
                    native_fem::NativeModalExecutionTarget::ProductionGpu
                } else {
                    native_fem::NativeModalExecutionTarget::ProductionCpu
                },
                expected_handoff,
            );
        }
        if use_sparse {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_sparse_lobpcg",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: sparse_lobpcg_candidate_count(
                        &plan.target,
                        num_modes,
                        effective_dof,
                    ),
                    computed_modes: 0,
                    iteration: Some(0),
                    max_iterations: None,
                    residual: None,
                    warning: None,
                },
            )?;
            solve_real_symmetric_eigenpairs_sparse(
                plan,
                &stiffness,
                &mass,
                num_modes,
                progress.as_deref_mut(),
                active_n,
                effective_dof,
            )?
        } else {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_dense",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: num_modes,
                    computed_modes: 0,
                    iteration: None,
                    max_iterations: None,
                    residual: None,
                    warning: dense_warning,
                },
            )?;
            let eigenpairs = solve_real_symmetric_eigenpairs(plan, &stiffness, &mass)?;
            dense_orthogonality = Some(orthogonality_rows_json(&mass, &eigenpairs));
            eigenpairs
        }
    } else {
        let operator = assemble_projected_scalar_operator_real(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
        );
        operator
            .validate_petsc_slepc_binding()
            .map_err(|message| RunError {
                message: format!("FEM eigen scalar operator is not bindable: {message}"),
            })?;
        if try_gpu {
            // Attempt GPU dense generalized solve; return error if GPU was
            // explicitly requested but is unavailable or fails.
            match gpu_solve_real_symmetric_eigenpairs(plan, &operator.stiffness, &operator.mass) {
                Ok(pairs) => {
                    eprintln!(
                        "info: FEM eigen GPU solve succeeded ({} modes)",
                        pairs.len()
                    );
                    dense_orthogonality = Some(orthogonality_rows_json(&operator.mass, &pairs));
                    pairs
                }
                Err(reason) => {
                    if reason.contains("UNAVAILABLE") {
                        return Err(RunError {
                            message: format!(
                                "FEM eigen GPU was explicitly requested but is unavailable: {reason}"
                            ),
                        });
                    } else {
                        return Err(RunError {
                            message: format!("FEM eigen GPU solve failed: {reason}"),
                        });
                    }
                }
            }
        } else if use_sparse {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_sparse_lobpcg",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: sparse_lobpcg_candidate_count(
                        &plan.target,
                        num_modes,
                        effective_dof,
                    ),
                    computed_modes: 0,
                    iteration: Some(0),
                    max_iterations: None,
                    residual: None,
                    warning: None,
                },
            )?;
            solve_real_symmetric_eigenpairs_sparse(
                plan,
                &operator.stiffness,
                &operator.mass,
                num_modes,
                progress.as_deref_mut(),
                active_n,
                effective_dof,
            )?
        } else {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_dense",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: num_modes,
                    computed_modes: 0,
                    iteration: None,
                    max_iterations: None,
                    residual: None,
                    warning: dense_warning,
                },
            )?;
            let eigenpairs =
                solve_real_symmetric_eigenpairs(plan, &operator.stiffness, &operator.mass)?;
            dense_orthogonality = Some(orthogonality_rows_json(&operator.mass, &eigenpairs));
            eigenpairs
        }
    };
    if use_sparse {
        solver_kind = "cpu_sparse_lobpcg";
    }
    let complex_eigenpairs = if complex_reduction {
        let (stiffness, mass) = if is_full_2x2 {
            assemble_projected_full_2x2_operator_complex(
                plan,
                topology,
                &reduction,
                &observables,
                &equilibrium,
                &bases,
            )
        } else {
            assemble_projected_scalar_operator_complex(
                plan,
                topology,
                &reduction,
                &observables,
                &equilibrium,
            )
        };
        if is_full_2x2 && use_native_modal_production {
            return execute_native_cpu_modal_window_from_bloch_floquet_complex(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &reduction,
                &bases,
                &stiffness,
                &mass,
                progress,
                active_n,
                effective_dof,
            );
        }
        solve_complex_hermitian_eigenpairs(plan, stiffness, mass)?
    } else {
        Vec::new()
    };

    let requested_modes = requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    let wants_dispersion = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }));

    let mut auxiliary_artifacts = Vec::new();
    let total_modes = if complex_reduction {
        complex_eigenpairs.len()
    } else {
        real_eigenpairs.len()
    };
    let mut modes_summary = Vec::with_capacity(total_modes);
    let participation_context = modal_participation_mesh_context(plan);
    let participation_solver_device = if try_gpu { "gpu" } else { "cpu" };
    let damping_factor = damping_imaginary_factor(plan.material.damping, plan.damping_policy);
    let gamma_rad_s_t = plan.gyromagnetic_ratio / MU0;
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let mu0_t_m_per_a = MU0;
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "writing_artifacts",
            phase_index: 4,
            phase_count: 5,
            percent: 85.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: total_modes,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    for mode_index in 0..total_modes {
        let (
            eigenvalue_real,
            eigenvalue_imag,
            residual_absolute_l2,
            residual_relative_l2,
            residual_linf,
            mass_norm,
            real,
            imag,
            amplitude,
            phase,
            max_amplitude,
            norm,
        ) = if complex_reduction {
            let pair = &complex_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = if is_full_2x2 {
                project_complex_2x2_mode_to_tangent_basis(
                    topology.n_nodes,
                    &reduction.active_nodes,
                    &pair.vector,
                    &bases,
                )
            } else {
                project_complex_mode_to_tangent_basis(
                    topology.n_nodes,
                    &reduction.active_nodes,
                    &pair.vector,
                    &bases,
                )
            };
            let norm = pair
                .vector
                .iter()
                .map(|value| value.norm_sqr())
                .sum::<f64>()
                .sqrt();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        } else if is_full_2x2 {
            let pair = &real_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = project_2x2_mode_to_tangent_basis(
                topology.n_nodes,
                &reduction.active_nodes,
                &pair.vector,
                &bases,
            );
            let norm = pair.vector.norm();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        } else {
            let pair = &real_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = project_real_mode_to_tangent_basis(
                topology.n_nodes,
                &reduction.active_nodes,
                &pair.vector,
                &bases,
            );
            let norm = pair.vector.norm();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        };
        let angular_frequency_real =
            angular_frequency_from_eigenvalue(plan.gyromagnetic_ratio, eigenvalue_real);
        let angular_frequency_imag = if eigenvalue_imag.abs() > 0.0 {
            angular_frequency_from_raw_eigenvalue(plan.gyromagnetic_ratio, eigenvalue_imag)
        } else {
            angular_frequency_real * damping_factor
        };
        let frequency_hz = angular_frequency_real / (2.0 * std::f64::consts::PI);
        let frequency_imag_hz = angular_frequency_imag / (2.0 * std::f64::consts::PI);
        let damping_included = matches!(plan.damping_policy, EigenDampingPolicyIR::Include);
        let phasor_convention = if damping_included {
            "exp_i_omega_t"
        } else {
            "not_applicable_real_reference"
        };
        let linewidth_fwhm_hz = 2.0 * frequency_imag_hz;
        let dominant_polarization = classify_polarization(
            &amplitude,
            &reduction.active_nodes,
            &equilibrium,
            max_amplitude,
        );
        let (tangent_leakage_mean_abs, tangent_leakage_max_abs) =
            mode_tangent_leakage(&equilibrium, &real, &imag);
        let component_participation = modal_participation_for_mode(
            &participation_context,
            plan,
            &real,
            &imag,
            participation_solver_device,
        );
        let mut mode_summary = serde_json::json!({
            "index": mode_index,
            "frequency_hz": frequency_hz,
            "frequency_real_hz": frequency_hz,
            "frequency_imag_hz": frequency_imag_hz,
            "angular_frequency_rad_per_s": angular_frequency_real,
            "omega_rad_s": angular_frequency_real,
            "angular_frequency_imag_rad_per_s": angular_frequency_imag,
            "eigenvalue_field_au_per_m": eigenvalue_real.max(0.0),
            "eigenvalue_real": eigenvalue_real,
            "eigenvalue_imag": eigenvalue_imag,
            "phasor_convention": phasor_convention,
            "eigenvalue_mapping": "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
            "norm": norm,
            "max_amplitude": max_amplitude,
            "residual_norm": residual_absolute_l2,
            "residual_absolute_l2": residual_absolute_l2,
            "residual_relative_l2": residual_relative_l2,
            "residual_linf": residual_linf,
            "mass_norm": mass_norm,
            "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
            "tangent_leakage_max_abs": tangent_leakage_max_abs,
            "gamma_rad_s_T": gamma_rad_s_t,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": mu0_t_m_per_a,
            "dominant_polarization": dominant_polarization,
            "k_vector": k_vector_json(plan.k_sampling.as_ref()),
            "component_participation": component_participation.clone(),
        });
        if damping_included {
            if let Some(object) = mode_summary.as_object_mut() {
                object.insert(
                    "complex_frequency_convention".to_string(),
                    serde_json::json!("omega_complex = omega_r + i Gamma for exp(i omega t)"),
                );
                object.insert(
                    "damping_rate_hz".to_string(),
                    serde_json::json!(frequency_imag_hz),
                );
                object.insert(
                    "linewidth_fwhm_hz".to_string(),
                    serde_json::json!(linewidth_fwhm_hz),
                );
            }
        }
        modes_summary.push(mode_summary.clone());

        if requested_modes.contains(&(mode_index as u32)) {
            let mut payload = serde_json::json!({
                "index": mode_index,
                "frequency_hz": frequency_hz,
                "frequency_real_hz": frequency_hz,
                "frequency_imag_hz": frequency_imag_hz,
                "angular_frequency_rad_per_s": angular_frequency_real,
                "omega_rad_s": angular_frequency_real,
                "angular_frequency_imag_rad_per_s": angular_frequency_imag,
                "eigenvalue_real": eigenvalue_real,
                "eigenvalue_imag": eigenvalue_imag,
                "phasor_convention": phasor_convention,
                "eigenvalue_mapping": "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
                "max_amplitude": max_amplitude,
                "residual_norm": residual_absolute_l2,
                "residual_absolute_l2": residual_absolute_l2,
                "residual_relative_l2": residual_relative_l2,
                "residual_linf": residual_linf,
                "mass_norm": mass_norm,
                "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
                "tangent_leakage_max_abs": tangent_leakage_max_abs,
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
                "normalization": normalization_label(plan.normalization),
                "damping_policy": damping_policy_label(plan.damping_policy),
                "solver_backend": "cpu_baseline_fem_eigen",
                "solver_kind": solver_kind,
                "solver_notes": solver_notes(plan, complex_reduction, use_sparse),
                "solver_capabilities": solver_capabilities(plan, complex_reduction, use_sparse),
                "solver_limitations": solver_limitations(plan, complex_reduction, use_sparse),
                "dominant_polarization": dominant_polarization,
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "real": real,
                "imag": imag,
                "amplitude": amplitude,
                "phase": phase,
                "component_participation": component_participation,
            });
            if damping_included {
                if let Some(object) = payload.as_object_mut() {
                    object.insert(
                        "complex_frequency_convention".to_string(),
                        serde_json::json!("omega_complex = omega_r + i Gamma for exp(i omega t)"),
                    );
                    object.insert(
                        "damping_rate_hz".to_string(),
                        serde_json::json!(frequency_imag_hz),
                    );
                    object.insert(
                        "linewidth_fwhm_hz".to_string(),
                        serde_json::json!(linewidth_fwhm_hz),
                    );
                }
            }
            auxiliary_artifacts.push(json_artifact(
                format!("eigen/modes/mode_{mode_index:04}.json"),
                &payload,
            )?);
        }
    }

    let mut summary_payload = serde_json::json!({
        "study_kind": "eigenmodes",
        "solver_backend": "cpu_baseline_fem_eigen",
        "solver_kind": solver_kind,
        "solver_notes": solver_notes(plan, complex_reduction, use_sparse),
        "solver_capabilities": solver_capabilities(plan, complex_reduction, use_sparse),
        "solver_limitations": solver_limitations(plan, complex_reduction, use_sparse),
        "mesh_name": plan.mesh_name,
        "mode_count": modes_summary.len(),
        "normalization": normalization_label(plan.normalization),
        "damping_policy": damping_policy_label(plan.damping_policy),
        "spin_wave_bc": spin_wave_bc_label(plan.spin_wave_bc.clone()),
        "boundary_config": spin_wave_bc_json(&plan.spin_wave_bc),
        "equilibrium_source": equilibrium_source_json(&plan.equilibrium),
        "included_terms": {
            "exchange": plan.enable_exchange,
            "demag": plan.enable_demag,
            "zeeman": plan.external_field.is_some(),
            "interfacial_dmi": plan.interfacial_dmi.is_some(),
            "bulk_dmi": plan.bulk_dmi.is_some(),
            "surface_anisotropy": plan.spin_wave_bc.surface_anisotropy_ks().is_some(),
        },
        "operator": {
            "kind": format!("{:?}", plan.operator.kind).to_lowercase(),
            "include_demag": plan.operator.include_demag,
        },
        "solver_diagnostics": {
            "dense_reference_oracle": !use_sparse && !complex_reduction,
            "algebraic_form": "reference_effective_field_generalized",
            "matrix_equation": "K u = lambda M u",
            "phasor_convention": "not_applicable_real_reference",
            "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
            "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
            "production_gyrotropic_mapping": false,
            "residual_definition": "relative_residual = ||K u - lambda M u||_2 / (||K u||_2 + |lambda| * ||M u||_2)",
            "tangent_leakage_definition": "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors",
            "constants": {
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
            },
            "orthogonality": dense_orthogonality,
        },
        "k_sampling": k_vector_json(plan.k_sampling.as_ref()),
        "relaxation_steps": relaxation_steps,
        "modes": modes_summary,
    });
    merge_modal_transport_diagnostics(
        &mut summary_payload["solver_diagnostics"],
        modal_tangent_transport_diagnostics(plan),
    );

    if wants_spectrum {
        auxiliary_artifacts.push(json_artifact("eigen/spectrum.json", &summary_payload)?);
    }
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/eigen_summary.json",
        &summary_payload,
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/normalization.json",
        &serde_json::json!({
            "normalization": normalization_label(plan.normalization),
            "mode_count": summary_payload["mode_count"],
        }),
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/equilibrium_source.json",
        &equilibrium_source_json(&plan.equilibrium),
    )?);

    if wants_dispersion {
        let visualizable_mode_indices = requested_modes
            .iter()
            .copied()
            .map(u64::from)
            .collect::<BTreeSet<_>>();
        let k_vector = k_vector_json(plan.k_sampling.as_ref());
        auxiliary_artifacts.push(json_artifact(
            "eigen/dispersion/path.json",
            &serde_json::json!({
                "sampling": plan.k_sampling,
                "k_vector": k_vector,
            }),
        )?);
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion/branch_table.csv".to_string(),
            bytes: dispersion_csv(plan.k_sampling.as_ref(), &summary_payload["modes"]).into_bytes(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(
                plan.k_sampling.as_ref(),
                &summary_payload["modes"],
                &visualizable_mode_indices,
            )
            .into_bytes(),
        });
    }
    write_eigen_v2_bundle(
        plan,
        &summary_payload,
        &requested_modes,
        &mut auxiliary_artifacts,
        0,
    )?;

    let stats = StepStats {
        step: relaxation_steps,
        time: 0.0,
        dt: 0.0,
        e_ex: observables.exchange_energy_joules,
        e_demag: observables.demag_energy_joules,
        e_ext: observables.external_energy_joules,
        e_total: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        ..StepStats::default()
    };

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "completed",
            phase_index: 5,
            phase_count: 5,
            percent: 100.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: total_modes,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![stats],
            final_magnetization: equilibrium.clone(),
            completion: Some(crate::relaxation::resolve_stage_completion(
                RunStatus::Completed,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: execution_provenance(plan, try_gpu),
    })
}

fn execute_native_modal_window(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    initial_magnetization: Vec<Vector3>,
    equilibrium: Vec<Vector3>,
    observables: EffectiveFieldObservables,
    relaxation_steps: u64,
    problem: &FemLlgProblem,
    source_artifact: Option<&LoadedEquilibriumArtifactV7>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    runner_operator: Option<(&DMatrix<f64>, &DMatrix<f64>)>,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
    artifact_sample_index: usize,
    execution_target: native_fem::NativeModalExecutionTarget,
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    let solver_kind = match execution_target {
        native_fem::NativeModalExecutionTarget::ProductionGpu => {
            NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND
        }
        _ => NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
    };
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "solving_native_shift_invert",
            phase_index: 3,
            phase_count: 5,
            percent: 35.0,
            solver_kind,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: plan.count as usize,
            computed_modes: 0,
            iteration: Some(0),
            max_iterations: Some(300),
            residual: None,
            warning: None,
        },
    )?;

    let shared_domain_linearization_state = if shared_domain_k0_modal_requested(plan) {
        Some(build_shared_domain_linearization_state(
            plan,
            topology,
            problem,
            source_artifact,
            source_relax_handoff,
            &equilibrium,
            &observables,
        )?)
    } else {
        None
    };
    let relax_to_eigen_handoff =
        match (expected_handoff, shared_domain_linearization_state.as_ref()) {
            (Some(handoff), Some(state)) => {
                handoff.validate_consumed_linearization(plan, &equilibrium, state)?;
                Some(handoff.clone())
            }
            (Some(_), None) => {
                return Err(RunError {
                    message: "relax_to_eigen_handoff_requires_linearization_state".to_string(),
                });
            }
            (None, Some(state))
                if matches!(
                    plan.equilibrium,
                    fullmag_ir::EquilibriumSourceIR::RelaxedInitialState
                ) =>
            {
                Some(
                    AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
                        plan,
                        equilibrium.clone(),
                        state.equilibrium_artifact_digest.clone(),
                        state.linearization_state_digest.clone(),
                    )?,
                )
            }
            (None, _) => None,
        };
    let shared_domain_problem = if shared_domain_k0_modal_requested(plan) {
        Some(build_native_shared_domain_modal_problem(
            plan,
            topology,
            &equilibrium,
            &observables,
            shared_domain_linearization_state.as_ref(),
            artifact_sample_index,
        )?)
    } else {
        None
    };
    if shared_domain_problem.is_some() && runner_operator.is_some() {
        return Err(RunError {
            message: "native shared-domain modal production must not assemble or transport a runner operator"
                .to_string(),
        });
    }
    if shared_domain_problem.is_none() && runner_operator.is_none() {
        return Err(RunError {
            message: "native non-shared-domain modal production requires the explicit runner operator payload"
                .to_string(),
        });
    }
    let operator_diagnostics_json = if let Some((stiffness_field, mass)) = runner_operator {
        full_2x2_native_operator_diagnostics_json(plan, stiffness_field, mass, active_nodes)
            .to_string()
    } else {
        serde_json::json!({
            "schema_version": "frequency_domain_operator_diagnostics.v1",
            "payload_kind": "certified_shared_domain",
            "assembly_owner": "native_mfem",
            "runner_operator_transport": "disabled",
        })
        .to_string()
    };
    let shared_domain_identity = shared_domain_problem
        .as_ref()
        .map(|problem| -> Result<serde_json::Value, RunError> {
            let magnetic_reduced_node_sha256 = shared_domain_content_digest(
                "operator_input_magnetic_reduced_node_map",
                &problem.magnetic_reduced_node,
            )?;
            let scalar_reduced_node_sha256 = shared_domain_content_digest(
                "operator_input_scalar_reduced_node_map",
                &problem.scalar_reduced_node,
            )?;
            let saturation_magnetisation_sha256 = shared_domain_content_digest(
                "operator_input_saturation_magnetisation",
                &problem.saturation_magnetisation_a_per_m,
            )?;
            let phase_constraint = serde_json::json!({
                "phase_convention": format!("{:?}", plan.spin_wave_bc.phase_convention()),
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "periodic_node_pairs": plan.mesh.periodic_node_pairs,
                "periodic_boundary_pairs": plan.mesh.periodic_boundary_pairs,
                "magnetic_reduced_node": problem.magnetic_reduced_node,
                "scalar_reduced_node": problem.scalar_reduced_node,
                "tangent_bases": bases,
            });
            // This signature is deliberately independent of the lane-specific
            // floating-point equilibrium, tangent-frame and linearization
            // artifacts.  It identifies the physical/operator inputs that CPU
            // and GPU must receive for the same sample; those state artifacts
            // remain separate provenance identities below and are compared by
            // their accepted physical state, not by bitwise hash equality.
            let operator_input_signature = serde_json::json!({
                "schema_version": "frequency_domain_operator_input_signature.v1",
                "assembly_kind": "mfem_weak_form_shared_domain",
                "demag_kind": "periodic_airbox_k0",
                "matrix_equation": "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
                "physics_contract_version": "micromagnetics_frequency_domain_v5",
                "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
                "phasor_convention": "exp_plus_i_omega_t",
                "eigenvalue_mapping": "lambda_imag_positive_frequency",
                "phase_convention": format!("{:?}", plan.spin_wave_bc.phase_convention()),
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "periodic_mesh_certificate_sha256": problem.mesh_certificate_digest,
                "periodic_modal_equivalence_map_binding_sha256":
                    problem.mesh_certificate_map_binding_digest,
                "magnetic_reduced_node_sha256": magnetic_reduced_node_sha256,
                "scalar_reduced_node_sha256": scalar_reduced_node_sha256,
                "magnetic_reduced_node_count": problem.magnetic_reduced_node_count,
                "scalar_reduced_node_count": problem.scalar_reduced_node_count,
                "q_dof_count": problem.magnetic_reduced_node_count.saturating_mul(2),
                "phi_dof_count": problem.scalar_reduced_node_count,
                "magnetic_pair_count": problem.magnetic_pair_count,
                "airbox_pair_count": problem.airbox_pair_count,
                "boundary_kind": problem.boundary_kind,
                "boundary_marker": problem.boundary_marker,
                "robin_beta": problem.robin_beta,
                "mesh_snapshot_id": problem.mesh_snapshot_id,
                "material_snapshot_id": problem.material_snapshot_id,
                "physics_snapshot_id": problem.physics_snapshot_id,
                "boundary_snapshot_id": problem.boundary_snapshot_id,
                "demag_model": problem.demag_model,
                "saturation_magnetisation_sha256": saturation_magnetisation_sha256,
                "uniform_saturation_magnetisation_a_per_m":
                    problem.uniform_saturation_magnetisation_a_per_m,
                "gamma0_m_per_a_s": problem.gamma0_m_per_a_s,
            });
            let operator_input_signature_sha256 = shared_domain_content_digest(
                "operator_input_signature",
                &operator_input_signature,
            )?;
            let linearization_state =
                if let Some(state) = shared_domain_linearization_state.as_ref() {
                    serde_json::json!({
                        "linearization_state": state.linearization_state_digest,
                        "equilibrium_artifact": state.equilibrium_artifact_digest,
                        "periodic_mesh_certificate": state.periodic_mesh_certificate_digest,
                    })
                } else {
                    serde_json::json!({
                        "equilibrium": equilibrium,
                        "operator_diagnostics": operator_diagnostics_json,
                    })
                };
            Ok(serde_json::json!({
                "operator_input_signature_sha256": operator_input_signature_sha256,
                "phase_constraint_sha256": shared_domain_content_digest(
                    "phase_constraint",
                    &phase_constraint,
                )?,
                "equilibrium_artifact_sha256": problem.equilibrium_digest,
                "linearization_state_sha256": shared_domain_content_digest(
                    "linearization_state",
                    &linearization_state,
                )?,
                "periodic_mesh_certificate_sha256": problem.mesh_certificate_digest,
                "periodic_modal_equivalence_map_binding_sha256":
                    problem.mesh_certificate_map_binding_digest,
            }))
        })
        .transpose()?;
    let stop_requested = AtomicBool::new(false);
    // Managed qualification can exercise the same native cancellation path as
    // an interactive stop without introducing a second solver implementation.
    // The deadline is opt-in and is intentionally read only by the modal
    // production path used by the cancellation gate.
    let cancellation_deadline = std::env::var("FULLMAG_FEM_EIGEN_CANCEL_AFTER_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(|milliseconds| Instant::now() + Duration::from_millis(milliseconds));
    let live_progress_sink = RefCell::new(progress.take());
    let cancel_callback = || {
        stop_requested.load(Ordering::Relaxed)
            || cancellation_deadline.is_some_and(|deadline| Instant::now() >= deadline)
    };
    let progress_callback = |progress_json: &str| {
        let Some(event) = native_modal_progress_event(
            progress_json,
            solver_kind,
            active_nodes,
            effective_dof,
            plan.count as usize,
        ) else {
            return;
        };
        if let Some(callback) = live_progress_sink.borrow_mut().as_deref_mut() {
            if callback(event) != StepAction::Continue {
                stop_requested.store(true, Ordering::Relaxed);
            }
        }
    };
    let runner_stiffness_omega =
        runner_operator.map(|(stiffness_field, _)| stiffness_field * plan.gyromagnetic_ratio);
    let runner_stiffness_row_major = runner_stiffness_omega
        .as_ref()
        .map(dmatrix_to_row_major)
        .unwrap_or_default();
    let runner_gyrotropic_row_major = runner_operator
        .map(|(_, mass)| gyrotropic_matrix_row_major_from_tangent_mass(mass, active_nodes))
        .transpose()?
        .unwrap_or_default();
    let runner_tangent_mass_row_major = runner_operator
        .map(|(_, mass)| dmatrix_to_row_major(mass))
        .unwrap_or_default();
    let runner_native_modal_topology = runner_operator
        .map(|_| {
            MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
                message: format!("failed to build native modal Floquet pair topology: {error}"),
            })
        })
        .transpose()?;
    let runner_floquet_periodic_pairs = runner_native_modal_topology
        .as_ref()
        .map(|topology| native_modal_floquet_periodic_pairs(plan, topology))
        .transpose()?
        .unwrap_or_default();
    let runner_magnetic_pencil = runner_operator.map(|_| {
        native_modal_magnetic_pencil_payload(
            plan,
            &runner_stiffness_row_major,
            &runner_gyrotropic_row_major,
            &runner_tangent_mass_row_major,
            &runner_floquet_periodic_pairs,
        )
    });
    let runner_mfem_operator_problem = runner_stiffness_omega
        .as_ref()
        .zip(runner_magnetic_pencil.as_ref())
        .map(|(stiffness_omega, magnetic_pencil)| {
            native_modal_mfem_operator_problem(
                stiffness_omega.nrows() as u64,
                &runner_stiffness_row_major,
                &runner_gyrotropic_row_major,
                &runner_tangent_mass_row_major,
                magnetic_pencil,
                &runner_floquet_periodic_pairs,
            )
        });
    let shared_domain_mode = shared_domain_problem.is_some();
    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: Some(operator_diagnostics_json.as_str()),
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        // The native production solver currently returns modal payloads to the
        // runner; its optional native diagnostic writer is reserved for the
        // explicit artifact-action contracts below.
        write_partial_artifacts: false,
        completeness_policy: 1,
        eigensolver_family: 1,
        spectral_transform_kind: 1,
        execution_target,
        cancel_requested: Some(&cancel_callback),
        progress_callback: Some(&progress_callback),
        tiny_validation_problem: None,
        mfem_operator_problem: runner_mfem_operator_problem,
        mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem,
    })
    .map_err(|message| RunError { message })?;
    progress = live_progress_sink.into_inner();

    let interrupted = native_result.status == native_fem::NativeFrequencyDomainStatus::Interrupted;
    if native_result.status != native_fem::NativeFrequencyDomainStatus::Ok && !interrupted {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen production {} solve failed: {} (diagnostics_json={})",
                if matches!(
                    execution_target,
                    native_fem::NativeModalExecutionTarget::ProductionGpu
                ) {
                    "GPU"
                } else {
                    "CPU"
                },
                native_result.error_message,
                native_result.diagnostics_json
            ),
        });
    }
    let mut solver_diagnostics = native_solver_diagnostics_json(
        plan,
        &native_result.diagnostics_json,
        Some(&native_result.result_json),
        native_result.modal_gpu_attestation.as_ref(),
    )?;
    if let (Some(identity), Some(diagnostics)) = (
        shared_domain_identity.as_ref(),
        solver_diagnostics.as_object_mut(),
    ) {
        if let Some(identity_object) = identity.as_object() {
            for (key, value) in identity_object {
                diagnostics.insert(key.clone(), value.clone());
            }
        }
    }
    if interrupted {
        if let Some(object) = solver_diagnostics.as_object_mut() {
            object.insert("status".to_string(), serde_json::json!("interrupted"));
            object.insert("complete".to_string(), serde_json::json!(false));
            object.insert(
                "stop_reason".to_string(),
                serde_json::json!("cancel_requested"),
            );
            object.insert(
                "partial_artifacts_available".to_string(),
                serde_json::json!(true),
            );
        }
    }
    let shared_domain_full_reduction =
        shared_domain_mode.then(|| full_physical_magnetic_reduction_map(topology));
    let shared_domain_full_mass = shared_domain_full_reduction
        .as_ref()
        .map(|full_reduction| assemble_tangent_mass_matrix(topology, full_reduction));
    let shared_mode_context_data = if let Some(full_mass) = shared_domain_full_mass.as_ref() {
        Some(reduced_shared_domain_tangent_mass(topology, full_mass)?)
    } else {
        None
    };
    let shared_mode_context = shared_mode_context_data.as_ref().map(
        |(reduced_tangent_mass, active_nodes, magnetic_classes, magnetic_class_count)| {
            SharedDomainModeContext {
                reduced_tangent_mass,
                active_nodes,
                magnetic_classes,
                magnetic_class_count: *magnetic_class_count,
            }
        },
    );
    let result_value = serde_json::from_str::<serde_json::Value>(&native_result.result_json)
        .map_err(|error| RunError {
            message: format!("failed to parse native modal result JSON: {error}"),
        })?;
    let has_modes_payload = result_value
        .get("modes")
        .and_then(serde_json::Value::as_array)
        .is_some();
    let modes = if has_modes_payload {
        native_modal_modes_from_result_json(
            plan,
            &native_result.result_json,
            runner_stiffness_omega.as_ref().and_then(|stiffness_omega| {
                runner_operator.map(|(_, mass)| {
                    (
                        stiffness_omega,
                        runner_gyrotropic_row_major.as_slice(),
                        mass,
                    )
                })
            }),
            shared_mode_context.as_ref(),
        )?
    } else if interrupted {
        Vec::new()
    } else {
        return Err(RunError {
            message: "native modal result JSON is missing complete modes[] payload".to_string(),
        });
    };
    if modes.is_empty() && !interrupted {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen production {solver_kind} solve returned no modes"
            ),
        });
    }

    if !interrupted {
        emit_fem_eigen_progress(
            &mut progress,
            FemEigenProgress {
                phase: "writing_artifacts",
                phase_index: 4,
                phase_count: 5,
                percent: 85.0,
                solver_kind,
                active_nodes,
                effective_dof,
                requested_modes: plan.count as usize,
                candidate_modes: modes.len(),
                computed_modes: modes.len(),
                iteration: None,
                max_iterations: None,
                residual: modes
                    .iter()
                    .map(|mode| mode.residual_relative_l2)
                    .reduce(f64::max),
                warning: None,
            },
        )?;
    }

    let artifact_reduction = shared_domain_full_reduction.as_ref().unwrap_or(reduction);
    let artifact_node_mass_weights = shared_domain_full_mass
        .as_ref()
        .and_then(|full_mass| {
            shared_domain_full_reduction
                .as_ref()
                .and_then(|full_reduction| {
                    node_mass_weights_from_tangent_mass(
                        full_mass,
                        full_reduction.active_nodes.len(),
                    )
                })
        })
        .or_else(|| {
            runner_operator
                .and_then(|(_, mass)| node_mass_weights_from_tangent_mass(mass, active_nodes))
        });
    let mut auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        artifact_reduction,
        bases,
        &modes,
        artifact_node_mass_weights.as_deref(),
        solver_diagnostics,
        relaxation_steps,
        shared_domain_linearization_state.as_ref(),
        relax_to_eigen_handoff.as_ref(),
        artifact_sample_index,
    )?;
    if interrupted {
        auxiliary_artifacts.push(json_artifact(
            "eigen/partial.v1.json",
            &serde_json::json!({
                "schema_version": "fem_k0_modal_partial.v1",
                "complete": false,
                "stop_reason": "cancelled",
                "preserved_mode_count": modes.len(),
            }),
        )?);
    }

    let stats = StepStats {
        step: relaxation_steps,
        time: 0.0,
        dt: 0.0,
        e_ex: observables.exchange_energy_joules,
        e_demag: observables.demag_energy_joules,
        e_ext: observables.external_energy_joules,
        e_total: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        ..StepStats::default()
    };

    if !interrupted {
        emit_fem_eigen_progress(
            &mut progress,
            FemEigenProgress {
                phase: "completed",
                phase_index: 5,
                phase_count: 5,
                percent: 100.0,
                solver_kind,
                active_nodes,
                effective_dof,
                requested_modes: plan.count as usize,
                candidate_modes: modes.len(),
                computed_modes: modes.len(),
                iteration: None,
                max_iterations: None,
                residual: None,
                warning: None,
            },
        )?;
    }

    let status = if interrupted {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps: vec![stats],
            final_magnetization: equilibrium,
            completion: Some(crate::relaxation::resolve_stage_completion(
                status,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: match execution_target {
            native_fem::NativeModalExecutionTarget::ProductionGpu => {
                native_gpu_modal_shared_domain_execution_provenance(
                    plan,
                    native_result.modal_gpu_attestation.as_ref(),
                )
            }
            _ => native_modal_execution_provenance(plan),
        },
    })
}

fn execute_native_cpu_modal_window_from_bloch_floquet_complex(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    initial_magnetization: Vec<Vector3>,
    equilibrium: Vec<Vector3>,
    observables: EffectiveFieldObservables,
    relaxation_steps: u64,
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
) -> Result<ExecutedRun, RunError> {
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "solving_native_shift_invert",
            phase_index: 3,
            phase_count: 5,
            percent: 35.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: plan.count as usize,
            computed_modes: 0,
            iteration: Some(0),
            max_iterations: Some(300),
            residual: None,
            warning: None,
        },
    )?;

    let payload = native_bloch_floquet_dense_payload_from_complex_pair(stiffness, mass)?;
    let payload = NativeBlochFloquetDensePayload {
        physical_complex_dof: payload.physical_complex_dof,
        stiffness: payload.stiffness * plan.gyromagnetic_ratio,
        gyrotropic_row_major: payload.gyrotropic_row_major,
        tangent_mass: payload.tangent_mass,
        physical_mass: payload.physical_mass,
    };
    let stiffness_row_major = dmatrix_to_row_major(&payload.stiffness);
    let tangent_mass_row_major = dmatrix_to_row_major(&payload.tangent_mass);
    let native_modal_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("failed to build native modal Bloch/Floquet pair topology: {error}"),
    })?;
    let native_floquet_periodic_pairs =
        native_modal_floquet_periodic_pairs(plan, &native_modal_topology)?;
    let magnetic_pencil = native_modal_magnetic_pencil_payload(
        plan,
        &stiffness_row_major,
        &payload.gyrotropic_row_major,
        &tangent_mass_row_major,
        &native_floquet_periodic_pairs,
    );
    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: Some(
            "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\
             \"payload_kind\":\"bloch_floquet_tangent_operator\",\
             \"stiffness_units\":\"rad_s_inv\",\
             \"gyrotropic_form\":\"pencil_B=-G=[[0,-M],[M,0]]\",\
             \"operator_embedding\":\"complex_bloch_floquet_to_real_gyrotropic_pencil\"}",
        ),
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        write_partial_artifacts: false,
        completeness_policy: 1,
        eigensolver_family: 1,
        spectral_transform_kind: 1,
        execution_target: native_fem::NativeModalExecutionTarget::ProductionCpu,
        cancel_requested: None,
        progress_callback: None,
        tiny_validation_problem: None,
        mfem_operator_problem: Some(native_modal_mfem_operator_problem(
            payload.stiffness.nrows() as u64,
            &stiffness_row_major,
            &payload.gyrotropic_row_major,
            &tangent_mass_row_major,
            &magnetic_pencil,
            &native_floquet_periodic_pairs,
        )),
        mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem: None,
    })
    .map_err(|message| RunError { message })?;

    if native_result.status != native_fem::NativeFrequencyDomainStatus::Ok {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen Bloch/Floquet production CPU solve failed: {} (diagnostics_json={})",
                native_result.error_message, native_result.diagnostics_json
            ),
        });
    }
    let solver_diagnostics = native_solver_diagnostics_json(
        plan,
        &native_result.diagnostics_json,
        Some(&native_result.result_json),
        None,
    )?;
    let modes =
        native_bloch_floquet_modes_from_result_json(plan, &native_result.result_json, &payload)?;
    if modes.is_empty() {
        return Err(RunError {
            message: "native FEM modal_eigen Bloch/Floquet production CPU solve returned no modes"
                .to_string(),
        });
    }

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "writing_artifacts",
            phase_index: 4,
            phase_count: 5,
            percent: 85.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: modes
                .iter()
                .map(|mode| mode.residual_relative_l2)
                .reduce(f64::max),
            warning: None,
        },
    )?;

    let auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        reduction,
        bases,
        &modes,
        None,
        solver_diagnostics,
        relaxation_steps,
        None,
        None,
        0,
    )?;

    let stats = StepStats {
        step: relaxation_steps,
        time: 0.0,
        dt: 0.0,
        e_ex: observables.exchange_energy_joules,
        e_demag: observables.demag_energy_joules,
        e_ext: observables.external_energy_joules,
        e_total: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        ..StepStats::default()
    };

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "completed",
            phase_index: 5,
            phase_count: 5,
            percent: 100.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![stats],
            final_magnetization: equilibrium,
            completion: Some(crate::relaxation::resolve_stage_completion(
                RunStatus::Completed,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: native_modal_execution_provenance(plan),
    })
}

fn dmatrix_to_row_major(matrix: &DMatrix<f64>) -> Vec<f64> {
    let mut values = Vec::with_capacity(matrix.nrows() * matrix.ncols());
    for row in 0..matrix.nrows() {
        for col in 0..matrix.ncols() {
            values.push(matrix[(row, col)]);
        }
    }
    values
}

fn matrix_abs_max(matrix: &DMatrix<f64>) -> f64 {
    matrix
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()))
}

// Byte-for-byte Rust implementation of the native CanonicalDigestBuilder
// protocol. Keep field tags and normalized IEEE-754 encoding in lockstep with
// backends/fem/src/frequency_domain/canonical_digest.cpp.
struct CanonicalDigestBuilder {
    payload: Vec<u8>,
}

impl CanonicalDigestBuilder {
    fn new(schema: &str) -> Self {
        let mut digest = Self {
            payload: Vec::new(),
        };
        digest.add_string("schema", schema);
        digest
    }

    fn add_field(&mut self, name: &str, field_type: u8, value: &[u8]) {
        self.payload
            .extend_from_slice(&(name.len() as u64).to_be_bytes());
        self.payload.extend_from_slice(name.as_bytes());
        self.payload.push(field_type);
        self.payload
            .extend_from_slice(&(value.len() as u64).to_be_bytes());
        self.payload.extend_from_slice(value);
    }

    fn add_string(&mut self, name: &str, value: &str) {
        self.add_field(name, 1, value.as_bytes());
    }

    fn add_u64(&mut self, name: &str, value: u64) {
        self.add_field(name, 2, &value.to_be_bytes());
    }

    fn add_bytes(&mut self, name: &str, value: &[u8]) {
        self.add_field(name, 3, value);
    }

    fn add_double(&mut self, name: &str, value: f64) {
        let normalized_bits = if value == 0.0 {
            0
        } else if value.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            value.to_bits()
        };
        self.add_field(name, 4, &normalized_bits.to_be_bytes());
    }

    fn add_double_slice(&mut self, name: &str, values: &[f64]) {
        self.add_u64(&format!("{name}.count"), values.len() as u64);
        for (index, value) in values.iter().enumerate() {
            self.add_double(&format!("{name}[{index}]"), *value);
        }
    }

    fn sha256_hex(self) -> String {
        format!("{:x}", Sha256::digest(self.payload))
    }
}

fn native_modal_magnetic_pencil_payload(
    plan: &FemEigenPlanIR,
    stiffness_matrix_row_major: &[f64],
    gyrotropic_matrix_row_major: &[f64],
    mass_matrix_row_major: &[f64],
    floquet_periodic_pairs: &[native_fem::NativeModalEigenFloquetPeriodicPair<'_>],
) -> NativeModalMagneticPencilPayload {
    let mut digest =
        CanonicalDigestBuilder::new("fullmag:native-modal-magnetic-payload-dependency:v1");
    digest.add_double_slice("stiffness_matrix_row_major", stiffness_matrix_row_major);
    digest.add_double_slice("gyrotropic_matrix_row_major", gyrotropic_matrix_row_major);
    digest.add_double_slice("mass_matrix_row_major", mass_matrix_row_major);
    digest.add_double_slice("gamma0_m_per_a_s", &[plan.gyromagnetic_ratio]);
    digest.add_double_slice("alpha", &[plan.material.damping]);
    digest.add_u64("include_exchange", u64::from(plan.enable_exchange));
    digest.add_u64("include_demag", u64::from(plan.enable_demag));
    digest.add_string(
        "demag_realization",
        resolved_demag_realization(plan)
            .map(|value| value.provenance_name())
            .unwrap_or("none"),
    );
    digest.add_bytes(
        "spin_wave_bc",
        &serde_json::to_vec(&plan.spin_wave_bc)
            .expect("spin-wave boundary condition must serialize for native modal digest"),
    );
    digest.add_bytes(
        "k_sampling",
        &serde_json::to_vec(&plan.k_sampling)
            .expect("k sampling must serialize for native modal digest"),
    );
    for (index, pair) in floquet_periodic_pairs.iter().enumerate() {
        let prefix = format!("floquet_pair[{index}]");
        digest.add_string(&format!("{prefix}.id"), pair.pair_id.unwrap_or(""));
        digest.add_u64(&format!("{prefix}.node_a"), pair.node_a);
        digest.add_u64(&format!("{prefix}.node_b"), pair.node_b);
        let translation_m: &[f64] = match &pair.translation_m {
            Some(value) => value,
            None => &[],
        };
        digest.add_double_slice(&format!("{prefix}.translation_m"), translation_m);
        let phase_rad = pair.phase_rad.map_or_else(Vec::new, |value| vec![value]);
        digest.add_double_slice(&format!("{prefix}.phase_rad"), &phase_rad);
    }

    NativeModalMagneticPencilPayload {
        dependency_digest: digest.sha256_hex(),
        gamma0_m_per_a_s: plan.gyromagnetic_ratio,
    }
}

fn native_modal_mfem_operator_problem<'a>(
    tangent_dof_count: u64,
    stiffness_matrix_row_major: &'a [f64],
    gyrotropic_matrix_row_major: &'a [f64],
    mass_matrix_row_major: &'a [f64],
    pencil: &'a NativeModalMagneticPencilPayload,
    floquet_periodic_pairs: &'a [native_fem::NativeModalEigenFloquetPeriodicPair<'a>],
) -> native_fem::NativeModalEigenMfemOperatorProblem<'a> {
    native_fem::NativeModalEigenMfemOperatorProblem {
        tangent_dof_count,
        stiffness_matrix_row_major: Some(stiffness_matrix_row_major),
        gyrotropic_matrix_row_major: Some(gyrotropic_matrix_row_major),
        mass_matrix_row_major: Some(mass_matrix_row_major),
        linearized_pencil_dependency_digest: Some(pencil.dependency_digest.as_str()),
        linearized_pencil_gamma0_m_per_a_s: pencil.gamma0_m_per_a_s,
        phase_convention: native_fem::FrequencyDomainPhaseConvention::ExpIOmegaT,
        floquet_periodic_pairs,
    }
}

fn full_2x2_native_operator_diagnostics_json(
    plan: &FemEigenPlanIR,
    stiffness_field: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    active_nodes: usize,
) -> serde_json::Value {
    let payload_kind = if native_cpu_modal_window_has_bloch_floquet_payload_path(plan) {
        "bloch_floquet_tangent_operator"
    } else {
        "rust_full_2x2_dense_operator"
    };
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_operator_diagnostics.v1",
        "payload_kind": payload_kind,
        "active_node_count": active_nodes,
        "tangent_dof_count": stiffness_field.nrows(),
        "stiffness_units": "A_per_m_mass_weighted",
        "gyrotropic_form": "pencil_B=-G=[[0,M],[-M,0]]",
        "stiffness_field_abs_max": matrix_abs_max(stiffness_field),
        "tangent_mass_abs_max": matrix_abs_max(mass),
    });

    let Some(object) = diagnostics.as_object_mut() else {
        return diagnostics;
    };
    let regularized_mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
    let Some(cholesky) = regularized_mass.cholesky() else {
        object.insert(
            "generalized_field_spectrum_status".to_string(),
            serde_json::json!("mass_cholesky_failed"),
        );
        return diagnostics;
    };
    let l = cholesky.l();
    let Some(l_inv) = l.try_inverse() else {
        object.insert(
            "generalized_field_spectrum_status".to_string(),
            serde_json::json!("mass_cholesky_inverse_failed"),
        );
        return diagnostics;
    };
    let transformed = &l_inv * stiffness_field * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let mut min_field = f64::INFINITY;
    let mut max_field = f64::NEG_INFINITY;
    let mut min_positive_frequency = f64::INFINITY;
    let mut max_positive_frequency = f64::NEG_INFINITY;
    let mut finite_count = 0_u64;
    let mut positive_count = 0_u64;
    for value in spectrum.eigenvalues.iter().copied() {
        if !value.is_finite() {
            continue;
        }
        finite_count += 1;
        min_field = min_field.min(value);
        max_field = max_field.max(value);
        if value > 0.0 {
            positive_count += 1;
            let frequency_hz = plan.gyromagnetic_ratio * value / std::f64::consts::TAU;
            min_positive_frequency = min_positive_frequency.min(frequency_hz);
            max_positive_frequency = max_positive_frequency.max(frequency_hz);
        }
    }
    object.insert(
        "generalized_field_spectrum_status".to_string(),
        serde_json::json!("available"),
    );
    object.insert(
        "generalized_field_eigenvalue_count".to_string(),
        serde_json::json!(finite_count),
    );
    object.insert(
        "generalized_field_positive_eigenvalue_count".to_string(),
        serde_json::json!(positive_count),
    );
    if finite_count > 0 {
        object.insert(
            "generalized_field_min_a_per_m".to_string(),
            serde_json::json!(min_field),
        );
        object.insert(
            "generalized_field_max_a_per_m".to_string(),
            serde_json::json!(max_field),
        );
    }
    if positive_count > 0 {
        object.insert(
            "generalized_positive_frequency_min_hz".to_string(),
            serde_json::json!(min_positive_frequency),
        );
        object.insert(
            "generalized_positive_frequency_max_hz".to_string(),
            serde_json::json!(max_positive_frequency),
        );
    }
    diagnostics
}

fn gyrotropic_matrix_row_major_from_tangent_mass(
    mass: &DMatrix<f64>,
    active_nodes: usize,
) -> Result<Vec<f64>, RunError> {
    let dim = active_nodes.checked_mul(2).ok_or_else(|| RunError {
        message: "native modal gyrotropic matrix dimension overflow".to_string(),
    })?;
    if mass.nrows() != dim || mass.ncols() != dim {
        return Err(RunError {
            message: format!(
                "native modal full_2x2 mass matrix has shape {}x{}, expected {}x{}",
                mass.nrows(),
                mass.ncols(),
                dim,
                dim
            ),
        });
    }
    let mut gyrotropic = vec![0.0; dim * dim];
    for row in 0..active_nodes {
        for col in 0..active_nodes {
            let tangent_mass = mass[(row, col)];
            gyrotropic[row * dim + col + active_nodes] = tangent_mass;
            gyrotropic[(row + active_nodes) * dim + col] = -tangent_mass;
        }
    }
    Ok(gyrotropic)
}

fn node_mass_weights_from_tangent_mass(
    mass: &DMatrix<f64>,
    active_nodes: usize,
) -> Option<Vec<f64>> {
    let dim = active_nodes.checked_mul(2)?;
    if active_nodes == 0 || mass.nrows() != dim || mass.ncols() != dim {
        return None;
    }
    let mut weights = Vec::with_capacity(active_nodes);
    for node in 0..active_nodes {
        let u = mass[(node, node)];
        let v = mass[(node + active_nodes, node + active_nodes)];
        if !(u.is_finite() && v.is_finite() && u > 0.0 && v > 0.0) {
            return None;
        }
        weights.push(0.5 * (u + v));
    }
    Some(weights)
}

fn native_solver_diagnostics_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    result_raw: Option<&str>,
    gpu_attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> Result<serde_json::Value, RunError> {
    let mut diagnostics =
        serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
            message: format!("failed to parse native modal diagnostics JSON: {error}"),
        })?;
    let Some(object) = diagnostics.as_object_mut() else {
        return Err(RunError {
            message: "native modal diagnostics JSON must be an object".to_string(),
        });
    };
    object.insert(
        "schema_version".to_string(),
        serde_json::json!("frequency_domain_modal_solver_diagnostics.v1"),
    );
    object
        .entry("solver_model".to_string())
        .or_insert_with(|| serde_json::json!("contour_interval_production_cpu_dense"));
    object
        .entry("resolved_solver_family".to_string())
        .or_insert_with(|| serde_json::json!("contour_interval"));
    object
        .entry("spectral_transform".to_string())
        .or_insert_with(|| serde_json::json!("contour_integral"));
    object
        .entry("algebraic_form".to_string())
        .or_insert_with(|| serde_json::json!("linearized_llg_generalized"));
    object
        .entry("matrix_equation".to_string())
        .or_insert_with(|| serde_json::json!("L phi = lambda B phi"));
    object
        .entry("phasor_convention".to_string())
        .or_insert_with(|| serde_json::json!("exp_i_omega_t"));
    object
        .entry("eigenvalue_mapping".to_string())
        .or_insert_with(|| serde_json::json!("lambda_eq_i_omega"));
    object
        .entry("frequency_mapping".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "frequency_hz = Im(lambda)/(2*pi) for the accepted positive-frequency branch"
            )
        });
    object
        .entry("production_gyrotropic_mapping".to_string())
        .or_insert_with(|| serde_json::json!(true));
    object
        .entry("dense_reference_oracle".to_string())
        .or_insert_with(|| serde_json::json!(false));
    object
        .entry("residual_definition".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "relative_residual = ||K phi - lambda B phi||_2 / (||K phi||_2 + |lambda| * ||B phi||_2), B=-G"
            )
        });
    object
        .entry("tangent_leakage_definition".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors"
            )
        });
    object.entry("constants".to_string()).or_insert_with(|| {
        serde_json::json!({
            "gamma_rad_s_T": plan.gyromagnetic_ratio / MU0,
            "gamma0_rad_s_per_A_m": plan.gyromagnetic_ratio,
            "mu0_T_m_per_A": MU0,
        })
    });
    if matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) && object
        .get("floquet_periodic_pair_count")
        .and_then(|value| value.as_u64())
        .is_some_and(|count| count > 0)
    {
        object.insert(
            "modal_periodic_pair_contract_available".to_string(),
            serde_json::json!(true),
        );
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        let requested_window_hz = serde_json::json!([
            native_modal_frequency_min_hz(&plan.target),
            native_modal_frequency_max_hz(&plan.target),
        ]);
        object
            .entry("requested_window_hz".to_string())
            .or_insert_with(|| requested_window_hz.clone());
        object
            .entry("resolved_search_window_hz".to_string())
            .or_insert(requested_window_hz);
        normalize_native_window_subwindows(object);
        object
            .entry("requested_mode_count".to_string())
            .or_insert_with(|| serde_json::json!(plan.count));
        let accepted_modes = object
            .get("accepted_mode_count_after_dedup")
            .or_else(|| object.get("accepted_mode_count"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        object
            .entry("mode_count".to_string())
            .or_insert_with(|| serde_json::json!(accepted_modes));
        object
            .entry("window_completeness".to_string())
            .or_insert_with(|| {
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": accepted_modes,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                })
            });
    }
    if let Some(result_raw) = result_raw {
        merge_poisson_airbox_modal_result_diagnostics(object, result_raw)?;
    }
    insert_native_poisson_airbox_hardened_contract(object, plan, gpu_attestation)?;
    // The hardened contract normalizes the lane-specific execution object;
    // enrich it last so native provenance fields cannot be discarded by that
    // normalization step.
    insert_native_poisson_airbox_execution_provenance(object, plan, gpu_attestation)?;
    Ok(diagnostics)
}

fn insert_native_poisson_airbox_execution_provenance(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
    plan: &FemEigenPlanIR,
    gpu_attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> Result<(), RunError> {
    let Some(adapter) = diagnostics
        .get("solver_adapter")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
    else {
        return Ok(());
    };
    if !is_native_poisson_airbox_modal_adapter(Some(adapter.as_str())) {
        return Ok(());
    }
    let gpu = matches!(
        adapter.as_str(),
        "k0_poisson_airbox_gpu_petsc_slepc" | "k0_poisson_airbox_gpu_modal_device_krylov"
    );
    if gpu && gpu_attestation.is_none() {
        return Err(RunError {
            message: "k0_poisson_airbox_gpu_attestation_missing".to_string(),
        });
    }

    let mut requested = diagnostics
        .get("requested_execution")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(requested_object) = requested.as_object_mut() {
        requested_object
            .entry("backend".to_string())
            .or_insert_with(|| serde_json::json!("fem"));
        requested_object
            .entry("device".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "gpu" } else { "cpu" }));
        requested_object
            .entry("precision".to_string())
            .or_insert_with(|| serde_json::json!("double"));
        requested_object
            .entry("include_demag".to_string())
            .or_insert_with(|| serde_json::json!(plan.operator.include_demag));
        requested_object
            .entry("solver_family".to_string())
            .or_insert_with(|| serde_json::json!("modal_eigen"));
        requested_object
            .entry("magnetostatic_bc".to_string())
            .or_insert_with(|| serde_json::json!("periodic_airbox_k0"));
    }
    diagnostics.insert("requested_execution".to_string(), requested);

    let mut resolved = diagnostics
        .get("resolved_execution")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(resolved_object) = resolved.as_object_mut() {
        resolved_object
            .entry("backend".to_string())
            .or_insert_with(|| serde_json::json!("fem"));
        resolved_object
            .entry("device".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "gpu" } else { "cpu" }));
        resolved_object
            .entry("precision".to_string())
            .or_insert_with(|| serde_json::json!("double"));
        resolved_object
            .entry("engine".to_string())
            .or_insert_with(|| {
                serde_json::json!(if gpu {
                    "gpu_petsc_slepc_cuda"
                } else {
                    "cpu_slepc_schur_targeted"
                })
            });
        resolved_object
            .entry("native_backend".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "native_gpu" } else { "native_cpu" }));
        resolved_object
            .entry("reference_or_production".to_string())
            .or_insert_with(|| serde_json::json!("production"));
        resolved_object
            .entry("demag_realization".to_string())
            .or_insert_with(|| {
                serde_json::json!(resolved_demag_realization(plan)
                    .map(|value| value.provenance_name())
                    .unwrap_or("none"))
            });
        resolved_object
            .entry("solver_algorithm".to_string())
            .or_insert_with(|| serde_json::json!(adapter));
        resolved_object
            .entry("solve_kind".to_string())
            .or_insert_with(|| serde_json::json!("modal_eigen"));
        resolved_object
            .entry("device_residency".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "gpu_device_resident" } else { "host" }));
        resolved_object
            .entry("fallback_used".to_string())
            .or_insert_with(|| serde_json::json!(false));
    }
    diagnostics.insert("resolved_execution".to_string(), resolved);
    if let Some(attestation) = gpu_attestation {
        diagnostics.insert(
            "gpu_execution_attestation".to_string(),
            attestation.artifact_json(),
        );
    }
    Ok(())
}

fn insert_native_poisson_airbox_hardened_contract(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
    plan: &FemEigenPlanIR,
    gpu_attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> Result<(), RunError> {
    let Some(adapter) = diagnostics
        .get("solver_adapter")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
    else {
        return Ok(());
    };
    if !is_native_poisson_airbox_modal_adapter(Some(adapter.as_str())) {
        return Ok(());
    }
    let production_implication = diagnostics
        .get("production_implication")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if production_implication {
        let required_string_fields = [
            "assembly_kind",
            "outer_boundary_kind",
            "gauge_policy",
            "gauge_reason",
        ];
        for field in required_string_fields {
            let valid = diagnostics
                .get(field)
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty() && value != "unknown");
            if !valid {
                return Err(RunError {
                    message: format!(
                        "native production Poisson-airbox diagnostics missing {field}"
                    ),
                });
            }
        }
        let assembly_kind = diagnostics
            .get("assembly_kind")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if assembly_kind != "mfem_weak_form_shared_domain" {
            return Err(RunError {
                message: format!(
                    "native production Poisson-airbox diagnostics have unsupported assembly_kind={assembly_kind:?}"
                ),
            });
        }
        let outer_boundary_kind = diagnostics
            .get("outer_boundary_kind")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if outer_boundary_kind == "poisson_robin" {
            let robin_beta = diagnostics
                .get("robin_beta")
                .and_then(|value| value.as_f64())
                .unwrap_or(f64::NAN);
            if !robin_beta.is_finite() || robin_beta <= 0.0 {
                return Err(RunError {
                    message: format!(
                        "native production Poisson-airbox diagnostics have invalid robin_beta={robin_beta:?}"
                    ),
                });
            }
        }
        for field in [
            "magnetic_block_backward_error",
            "poisson_block_backward_error",
            "gauge_constraint_backward_error",
        ] {
            let value = diagnostics_number(diagnostics, field).unwrap_or(f64::NAN);
            if !value.is_finite() || value < 0.0 {
                return Err(RunError {
                    message: format!(
                        "native production Poisson-airbox diagnostics missing finite {field}"
                    ),
                });
            }
        }
        if diagnostics
            .get("full_residual_certified")
            .and_then(|value| value.as_bool())
            != Some(true)
        {
            return Err(RunError {
                message: "native production Poisson-airbox diagnostics missing full_residual_certified=true"
                    .to_string(),
            });
        }
    }
    let gpu = matches!(
        adapter.as_str(),
        "k0_poisson_airbox_gpu_petsc_slepc" | "k0_poisson_airbox_gpu_modal_device_krylov"
    );
    if gpu && gpu_attestation.is_none() {
        return Err(RunError {
            message: "k0_poisson_airbox_gpu_attestation_missing".to_string(),
        });
    }
    let cpu_schur = adapter == "k0_poisson_airbox_cpu_schur_slepc";
    let eps_q = diagnostics_number(diagnostics, "magnetic_block_backward_error").unwrap_or(0.0);
    let eps_phi = diagnostics_number(diagnostics, "poisson_block_backward_error").unwrap_or(0.0);
    let eps_gauge =
        diagnostics_number(diagnostics, "gauge_constraint_backward_error").unwrap_or(0.0);
    let eps_full = eps_q.max(eps_phi).max(eps_gauge);
    let certification_tolerance = diagnostics_number(diagnostics, "residual_tolerance")
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0e-8_f64);
    let outer_boundary_kind = diagnostics
        .get("outer_boundary_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let gauge_policy = diagnostics
        .get("gauge_policy")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let gauge_reason = diagnostics
        .get("gauge_reason")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let target_omega = diagnostics_number(diagnostics, "target_omega_rad_s")
        .unwrap_or_else(|| native_modal_target_frequency_hz(&plan.target) * std::f64::consts::TAU);
    let requested_device = if gpu { "gpu" } else { "cpu" };
    let engine = if gpu {
        "gpu_petsc_slepc_cuda"
    } else if cpu_schur {
        "cpu_slepc_schur_targeted"
    } else {
        "cpu_slepc_shift_invert"
    };
    let solver_library = if gpu {
        "SLEPc/PETSc/hypre CUDA"
    } else {
        "SLEPc/PETSc"
    };
    let status = diagnostics
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let fallback_used = diagnostics
        .get("fallback_used")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let fallback_reason = diagnostics
        .get("fallback_reason")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let robin_beta = diagnostics
        .get("robin_beta")
        .cloned()
        .unwrap_or(serde_json::json!(0.0));
    let spectral_transform = diagnostics
        .get("spectral_transform")
        .cloned()
        .unwrap_or_else(|| {
            serde_json::json!(if gpu {
                "shift_invert"
            } else if cpu_schur {
                "shift_invert"
            } else {
                "shift_invert"
            })
        });
    let spectral_pencil_kind = diagnostics
        .get("spectral_pencil_kind")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("real_frequency_rotated"));
    let target_representation = diagnostics
        .get("target_representation")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("tau=omega_target"));
    let target_tau_rad_s = diagnostics
        .get("target_tau_rad_s")
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(target_omega);
    let linear_control_d2h_transfer_count = gpu_attestation
        .map(|value| value.hot_loop_scalar_telemetry_syncs)
        .or_else(|| {
            diagnostics_number(diagnostics, "linear_control_d2h_transfer_count")
                .map(|value| value.max(0.0) as u64)
        })
        .unwrap_or(0);
    let setup_h2d_transfer_count = gpu_attestation
        .map(|value| value.setup_h2d_count)
        .or_else(|| {
            diagnostics_number(diagnostics, "setup_h2d_transfer_count")
                .or_else(|| diagnostics_number(diagnostics, "setup_h2d_block_transfers"))
                .map(|value| value.max(0.0) as u64)
        })
        .unwrap_or(0);
    let final_d2h_transfer_count = gpu_attestation
        .map(|value| value.export_d2h_count)
        .or_else(|| {
            diagnostics_number(diagnostics, "final_d2h_transfer_count")
                .or_else(|| diagnostics_number(diagnostics, "final_d2h_vector_transfers"))
                .map(|value| value.max(0.0) as u64)
        })
        .unwrap_or(0);
    diagnostics.insert(
        "physics_contract_version".to_string(),
        serde_json::json!("micromagnetics_frequency_domain_v5"),
    );
    diagnostics.insert(
        "operator_dictionary_version".to_string(),
        serde_json::json!("FrequencyOperatorDictionary.v1"),
    );
    diagnostics.insert(
        "implementation_state".to_string(),
        serde_json::json!("executable"),
    );
    diagnostics.insert(
        "validation_state".to_string(),
        serde_json::json!("unvalidated"),
    );
    diagnostics.insert(
        "execution_lane".to_string(),
        serde_json::json!(if gpu {
            "production_gpu"
        } else {
            "production_cpu"
        }),
    );
    diagnostics.insert(
        "production_periodic_airbox_claim".to_string(),
        serde_json::json!(true),
    );
    diagnostics.insert(
        "validated_scope".to_string(),
        serde_json::json!(if gpu {
            serde_json::Value::Null
        } else {
            serde_json::json!("fem_k0_periodic_airbox_p1_double_cpu_slepc")
        }),
    );
    diagnostics.insert(
        "requested_execution".to_string(),
        serde_json::json!({
            "backend": "fem",
            "device": requested_device,
            "precision": "double",
            "execution_mode": "strict",
            "study_product": "modal_eigen",
            "solver_method": if gpu || !cpu_schur {
                "shift_invert"
            } else {
                "targeted_spectrum"
            },
            "preconditioner": if gpu { "shifted_schur_device" } else { "lu" },
            "include_demag": true,
            "magnetostatic_bc": "periodic_airbox_k0",
        }),
    );
    diagnostics.insert(
        "resolved_execution".to_string(),
        serde_json::json!({
            "backend": "fem",
            "device": requested_device,
            "precision": "double",
            "engine": engine,
            "implementation_id": adapter,
            "solver_library": solver_library,
            "operator_residency": if gpu { "device" } else { "host" },
            "vector_residency": if gpu { "device" } else { "host" },
            "krylov_residency": if gpu { "device" } else { "host" },
            "preconditioner_residency": if gpu { "device" } else { "host" },
            "fallback_used": fallback_used,
            "fallback_reason": fallback_reason,
            "status": status,
        }),
    );
    diagnostics.insert(
        "boundary_gauge".to_string(),
        serde_json::json!({
            "magnetostatic_bc": "periodic_airbox_k0",
            "outer_boundary_kind": outer_boundary_kind,
            "robin_beta": robin_beta,
            "robin_beta_unit": "1/m",
            "gauge_policy": gauge_policy,
            "gauge_reason": gauge_reason,
            "eta_row_present": gauge_policy == "mean_zero_augmented",
        }),
    );
    diagnostics.insert(
        "spectral".to_string(),
        serde_json::json!({
            "spectral_transform": spectral_transform,
            "spectral_pencil_kind": spectral_pencil_kind,
            "spectral_scalar_mode": "real_split",
            "target_representation": target_representation,
            "tau_rad_per_s": target_tau_rad_s,
        }),
    );
    diagnostics.insert(
        "block_residuals".to_string(),
        serde_json::json!({
            "eps_q": eps_q,
            "eps_phi": eps_phi,
            "eps_gauge": eps_gauge,
            "eps_full": eps_full,
            "backend_reported_residual": diagnostics_number(diagnostics, "slepc_reported_backward_error").unwrap_or_else(|| diagnostics_number(diagnostics, "last_residual_relative").unwrap_or(eps_full)),
            "certification_tolerance": certification_tolerance,
            "certified": eps_full <= certification_tolerance,
        }),
    );
    diagnostics.insert(
        "device_transfer_audit".to_string(),
        serde_json::json!({
            "setup_h2d_transfer_count": setup_h2d_transfer_count,
            "final_d2h_transfer_count": final_d2h_transfer_count,
            "hot_loop_h2d_bytes": gpu_attestation.map(|value| value.hot_loop_computational_h2d_bytes),
            "hot_loop_d2h_bytes": gpu_attestation.map(|value| value.hot_loop_computational_d2h_bytes),
            "hot_loop_host_sync_count": linear_control_d2h_transfer_count,
            "control_scalar_d2h_bytes": gpu_attestation.map(|value| value.hot_loop_scalar_telemetry_d2h_bytes),
            "device_resident_claim": gpu_attestation.map(|value| value.device_residency_verified).unwrap_or(false),
        }),
    );
    Ok(())
}

fn diagnostics_number(
    diagnostics: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<f64> {
    diagnostics
        .get(key)
        .or_else(|| diagnostics.get("metrics").and_then(|value| value.get(key)))
        .and_then(|value| value.as_f64())
}

fn normalize_native_window_subwindows(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
) {
    let raw_subwindows = diagnostics
        .get("executed_subwindows")
        .cloned()
        .or_else(|| diagnostics.get("subwindows").cloned());
    let Some(serde_json::Value::Array(subwindows)) = raw_subwindows else {
        return;
    };

    let normalized = subwindows
        .into_iter()
        .filter_map(|subwindow| {
            let mut object = subwindow.as_object()?.clone();
            if let Some(status) = object.get("status").and_then(|value| value.as_str()) {
                let normalized_status = match status {
                    "failed" | "interrupted" => "solve_error",
                    other => other,
                };
                object.insert(
                    "status".to_string(),
                    serde_json::Value::String(normalized_status.to_string()),
                );
            }
            object
                .entry("accepted_frequencies_hz".to_string())
                .or_insert_with(|| serde_json::json!([]));
            if !object.contains_key("candidate_mode_count") {
                let accepted_mode_count = object
                    .get("accepted_mode_count")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!(0));
                object.insert("candidate_mode_count".to_string(), accepted_mode_count);
            }
            Some(serde_json::Value::Object(object))
        })
        .collect::<Vec<_>>();
    diagnostics.insert(
        "subwindows".to_string(),
        serde_json::Value::Array(normalized),
    );
    diagnostics.remove("executed_subwindows");
}

fn merge_poisson_airbox_modal_result_diagnostics(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
    result_raw: &str,
) -> Result<(), RunError> {
    let result =
        serde_json::from_str::<serde_json::Value>(result_raw).map_err(|error| RunError {
            message: format!("failed to parse native modal result JSON: {error}"),
        })?;
    let solver_adapter = result
        .get("solver_adapter")
        .and_then(|value| value.as_str());
    if !is_native_poisson_airbox_modal_adapter(solver_adapter) {
        return Ok(());
    }
    let gpu = matches!(
        solver_adapter,
        Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    );
    let cpu_schur = solver_adapter == Some("k0_poisson_airbox_cpu_schur_slepc");
    let gpu_scalable_selected_spectrum = result
        .get("scalable_selected_spectrum")
        .and_then(|value| value.as_bool())
        .or_else(|| {
            diagnostics
                .get("scalable_selected_spectrum")
                .and_then(|value| value.as_bool())
        })
        .unwrap_or(gpu);
    diagnostics.insert(
        "solver_model".to_string(),
        serde_json::json!(solver_adapter.unwrap_or("unknown")),
    );
    diagnostics.insert(
        "resolved_solver_family".to_string(),
        serde_json::json!(if gpu {
            if gpu_scalable_selected_spectrum {
                "device_resident_arnoldi_shift_invert"
            } else {
                "device_dense_validation_shift_invert"
            }
        } else if cpu_schur {
            "k0_poisson_airbox_schur"
        } else {
            "k0_poisson_airbox_full_coupled"
        }),
    );
    diagnostics.insert(
        "spectral_transform".to_string(),
        serde_json::json!(if gpu {
            "shift_invert"
        } else if cpu_schur {
            "shift_invert"
        } else {
            "shift_invert"
        }),
    );
    diagnostics.insert(
        "algebraic_form".to_string(),
        serde_json::json!(if gpu {
            "schur_reduced_descriptor"
        } else if cpu_schur {
            "schur_reduced_descriptor"
        } else {
            "full_coupled_poisson_airbox_augmented_gauge"
        }),
    );
    if gpu {
        diagnostics.insert(
            "scalable_selected_spectrum".to_string(),
            serde_json::json!(gpu_scalable_selected_spectrum),
        );
    }
    diagnostics.insert(
        "matrix_equation".to_string(),
        serde_json::json!(if gpu || cpu_schur {
            "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q"
        } else {
            "A_full x = lambda B_full x"
        }),
    );
    diagnostics.insert(
        "phasor_convention".to_string(),
        serde_json::json!("exp_plus_i_omega_t"),
    );
    diagnostics.insert(
        "eigenvalue_mapping".to_string(),
        serde_json::json!("lambda_imag_positive_frequency"),
    );
    let fields = [
        ("solver_adapter", &["solver_adapter"][..]),
        ("demag_kind", &["demag_kind"][..]),
        ("gauge_policy", &["gauge_policy"][..]),
        ("q_dof_count", &["q_dof_count"][..]),
        ("phi_dof_count", &["phi_dof_count"][..]),
        ("augmented_dof_count", &["augmented_dof_count"][..]),
        ("augmented_phi_dof_count", &["augmented_phi_dof_count"][..]),
        ("residual_tolerance", &["residual_tolerance"][..]),
        (
            "poisson_constraint_relative_residual",
            &["metrics", "poisson_constraint_relative_residual"][..],
        ),
        (
            "full_residual_reconstruction_relative_error",
            &["metrics", "full_residual_reconstruction_relative_error"][..],
        ),
        (
            "relative_reference_frequency_error",
            &["metrics", "relative_reference_frequency_error"][..],
        ),
        ("omega_rad_s", &["eigenpair", "omega_rad_s"][..]),
        ("frequency_hz", &["eigenpair", "frequency_hz"][..]),
    ];
    for (field, path) in fields {
        if diagnostics.contains_key(field) {
            continue;
        }
        if let Some(value) =
            json_value_at(&result, field).or_else(|| json_nested_value(&result, path))
        {
            diagnostics.insert(field.to_string(), value.clone());
        }
    }
    if !diagnostics.contains_key("augmented_phi_dof_count") {
        if let Some(augmented_dof_count) = diagnostics
            .get("augmented_dof_count")
            .and_then(|value| value.as_u64())
        {
            let q_dof_count = diagnostics
                .get("q_dof_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            if augmented_dof_count >= q_dof_count {
                diagnostics.insert(
                    "augmented_phi_dof_count".to_string(),
                    serde_json::json!(augmented_dof_count - q_dof_count),
                );
            }
        }
    }
    if !diagnostics.contains_key("accepted_mode_count") {
        if let Some(value) = json_value_at(&result, "accepted_mode_count")
            .or_else(|| json_nested_value(&result, &["slepc", "accepted_mode_count"]))
        {
            diagnostics.insert("accepted_mode_count".to_string(), value.clone());
        }
    }
    Ok(())
}

fn is_native_poisson_airbox_modal_adapter(adapter: Option<&str>) -> bool {
    matches!(
        adapter,
        Some("k0_poisson_airbox_cpu_full_coupled_slepc")
            | Some("k0_poisson_airbox_cpu_schur_slepc")
            | Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    )
}

fn json_value_at<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    value.get(key)
}

fn json_nested_value<'a>(
    value: &'a serde_json::Value,
    path: &[&str],
) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

#[allow(dead_code)]
pub(crate) fn native_poisson_airbox_k0_metrics_from_result_json(
    raw: &str,
    input: NativePoissonAirboxK0MetricsInput,
) -> Result<crate::eigen::K0KittelPeriodicAirboxDemagMetrics, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native Poisson-airbox modal result JSON: {error}"),
    })?;
    let demag_kind = result
        .get("demag_kind")
        .and_then(|value| value.as_str())
        .ok_or_else(|| RunError {
            message: "native Poisson-airbox modal result JSON is missing demag_kind".to_string(),
        })?;
    if demag_kind != "periodic_airbox_k0" {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal result demag_kind must be periodic_airbox_k0, got {demag_kind}"
            ),
        });
    }
    let solver_adapter = result
        .get("solver_adapter")
        .and_then(|value| value.as_str())
        .ok_or_else(|| RunError {
            message: "native Poisson-airbox modal result JSON is missing solver_adapter"
                .to_string(),
        })?;
    if !is_native_poisson_airbox_modal_adapter(Some(solver_adapter)) {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal result solver_adapter must be a supported CPU/GPU K0 adapter, got {solver_adapter}"
            ),
        });
    }
    let phi_dof_count = required_u64(&result, "phi_dof_count").or_else(|_| {
        required_u64(&result, "poisson_phi_dof_count").or_else(|_| {
            Err(RunError {
                message: "native Poisson-airbox modal result JSON is missing phi_dof_count"
                    .to_string(),
            })
        })
    })?;
    let augmented_phi_dof_count =
        required_u64(&result, "augmented_phi_dof_count").or_else(|_| {
            required_u64(&result, "poisson_augmented_phi_dof_count").or_else(|_| {
                let augmented_dof_count = required_u64(&result, "augmented_dof_count")?;
                let q_dof_count = required_u64(&result, "q_dof_count")?;
                augmented_dof_count
                    .checked_sub(q_dof_count)
                    .ok_or_else(|| RunError {
                        message: "native Poisson-airbox modal result JSON has augmented_dof_count < q_dof_count".to_string(),
                    })
            })
        })?;
    let poisson_constraint_relative_residual =
        required_f64(&result, "poisson_constraint_relative_residual")?;
    let relative_kittel_frequency_error =
        required_f64(&result, "relative_reference_frequency_error")?;
    if !(input.mesh_resolution_m.is_finite() && input.mesh_resolution_m > 0.0) {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require positive mesh_resolution_m"
                .to_string(),
        });
    }
    if !(input.airbox_size_m.is_finite() && input.airbox_size_m > 0.0) {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require positive airbox_size_m".to_string(),
        });
    }
    if input.magnetic_pair_count == 0 || input.airbox_pair_count == 0 {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require magnetic and airbox pair counts"
                .to_string(),
        });
    }
    if !(input.effective_magnetisation_a_per_m.is_finite()
        && input.effective_magnetisation_a_per_m > 0.0)
    {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require positive effective magnetisation"
                .to_string(),
        });
    }
    if !(poisson_constraint_relative_residual.is_finite()
        && poisson_constraint_relative_residual >= 0.0)
    {
        return Err(RunError {
            message: "native Poisson-airbox modal result has invalid Poisson constraint residual"
                .to_string(),
        });
    }
    if !(relative_kittel_frequency_error.is_finite() && relative_kittel_frequency_error >= 0.0) {
        return Err(RunError {
            message: "native Poisson-airbox modal result has invalid reference frequency error"
                .to_string(),
        });
    }
    Ok(crate::eigen::K0KittelPeriodicAirboxDemagMetrics {
        mesh_resolution_m: input.mesh_resolution_m,
        airbox_size_m: input.airbox_size_m,
        phi_dof_count,
        augmented_phi_dof_count,
        poisson_constraint_relative_residual,
        magnetic_pair_count: input.magnetic_pair_count,
        airbox_pair_count: input.airbox_pair_count,
        effective_magnetisation_a_per_m: input.effective_magnetisation_a_per_m,
        relative_kittel_frequency_error,
    })
}

fn native_modal_modes_from_result_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    runner_operator: Option<(&DMatrix<f64>, &[f64], &DMatrix<f64>)>,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native modal result JSON: {error}"),
    })?;
    let Some(modes) = result.get("modes").and_then(|value| value.as_array()) else {
        return Err(RunError {
            message: "native modal result JSON is missing complete modes[] payload".to_string(),
        });
    };
    let poisson_airbox = is_native_poisson_airbox_modal_adapter(
        result
            .get("solver_adapter")
            .and_then(|value| value.as_str()),
    );
    let mut modes = modes
        .iter()
        .map(|mode| {
            if poisson_airbox {
                let tangent_mass = shared_domain_context
                    .map(|context| context.reduced_tangent_mass)
                    .or_else(|| runner_operator.map(|(_, _, tangent_mass)| tangent_mass))
                    .ok_or_else(|| RunError {
                        message: "native Poisson-airbox modal result is missing its native shared-domain mass context"
                            .to_string(),
                    })?;
                native_poisson_airbox_mode_from_json(
                    plan,
                    mode,
                    tangent_mass,
                    shared_domain_context,
                )
            } else {
                let (stiffness_omega, gyrotropic_row_major, tangent_mass) =
                    runner_operator.ok_or_else(|| RunError {
                        message: "native non-shared modal result is missing its explicit runner operator context"
                            .to_string(),
                    })?;
                native_modal_mode_from_json(
                    plan,
                    mode,
                    stiffness_omega,
                    gyrotropic_row_major,
                    tangent_mass,
                )
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    assign_modal_frequency_clusters(&mut modes);
    Ok(modes)
}

/// Assign deterministic multiplicity clusters from the accepted spectrum.
/// Native backends may expose an implementation-specific cluster id, but the
/// public artifact needs one stable rule shared by CPU and GPU lanes.  Modes
/// whose positive frequencies differ by at most the relative tolerance belong
/// to the same cluster; the original mode ordering is preserved.
fn assign_modal_frequency_clusters(modes: &mut [NativeModalEigenpair]) {
    const RELATIVE_CLUSTER_TOLERANCE: f64 = 1.0e-7;
    let mut ordered = (0..modes.len()).collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        modes[*left]
            .frequency_hz
            .total_cmp(&modes[*right].frequency_hz)
            .then_with(|| left.cmp(right))
    });
    let mut next_cluster = 0_u64;
    let mut previous_frequency: Option<f64> = None;
    for index in ordered {
        let frequency = modes[index].frequency_hz;
        let starts_new_cluster = previous_frequency
            .map(|previous| {
                (frequency - previous).abs()
                    > RELATIVE_CLUSTER_TOLERANCE * frequency.abs().max(previous.abs()).max(1.0)
            })
            .unwrap_or(true);
        if starts_new_cluster {
            next_cluster = next_cluster.saturating_add(1);
        }
        modes[index].cluster_id = next_cluster.saturating_sub(1);
        previous_frequency = Some(frequency);
    }
}

fn native_poisson_airbox_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    tangent_mass: &DMatrix<f64>,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
) -> Result<NativeModalEigenpair, RunError> {
    let real = mode
        .get("mode_q_real")
        .map(|_| required_f64_array(mode, "mode_q_real"))
        .unwrap_or_else(|| required_f64_array(mode, "mode_vector_real"))?;
    let imag = mode
        .get("mode_q_imag")
        .map(|_| required_f64_array(mode, "mode_q_imag"))
        .unwrap_or_else(|| required_f64_array(mode, "mode_vector_imag"))?;
    if real.len() != imag.len() || real.len() != tangent_mass.nrows() {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal q vector length mismatch: real={}, imag={}, tangent_operator={}",
                real.len(),
                imag.len(),
                tangent_mass.nrows()
            ),
        });
    }
    let mut vector = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
    if mode.get("q_layout").and_then(|value| value.as_str()) == Some("interleaved_node_component") {
        if vector.len() % 2 != 0 {
            return Err(RunError {
                message: "native shared-domain modal interleaved q vector has odd length"
                    .to_string(),
            });
        }
        let node_count = vector.len() / 2;
        let mut block_order = vec![Complex64::new(0.0, 0.0); vector.len()];
        for node in 0..node_count {
            block_order[node] = vector[2 * node];
            block_order[node_count + node] = vector[2 * node + 1];
        }
        vector = block_order;
    }
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    if eigenvalue_real.abs() > 1.0e-9 * eigenvalue_imag.abs().max(1.0) {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox real-frequency-rotated mode has nonzero real eigenvalue: {}",
                eigenvalue_real
            ),
        });
    }
    let normalization_scale =
        complex_block_mode_normalization_scale(&vector, tangent_mass, plan.normalization);
    normalize_complex_block_mode(&mut vector, tangent_mass, plan.normalization);
    let phi_real = mode
        .get("mode_phi_real")
        .map(|_| required_f64_array(mode, "mode_phi_real"))
        .unwrap_or_else(|| Ok(Vec::new()))?;
    let phi_imag = mode
        .get("mode_phi_imag")
        .map(|_| required_f64_array(mode, "mode_phi_imag"))
        .unwrap_or_else(|| Ok(Vec::new()))?;
    if phi_real.len() != phi_imag.len() {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal phi vector length mismatch: real={}, imag={}",
                phi_real.len(),
                phi_imag.len()
            ),
        });
    }
    if shared_domain_context.is_some() && phi_real.is_empty() {
        return Err(RunError {
            message: "native shared-domain modal result is missing the reconstructed phi vector"
                .to_string(),
        });
    }
    let phi_vector = phi_real
        .iter()
        .zip(phi_imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im) / normalization_scale)
        .collect::<Vec<_>>();
    let residual = mode
        .get("full_residual_reconstruction_relative_error")
        .map(|_| required_f64(mode, "full_residual_reconstruction_relative_error"))
        .unwrap_or_else(|| required_f64(mode, "relative_residual"))?;
    let residual_relative_l2 = mode
        .get("relative_residual")
        .map(|_| required_f64(mode, "relative_residual"))
        .unwrap_or(Ok(residual))?;
    let block_residual_q = if shared_domain_context.is_some() {
        required_f64(mode, "magnetic_block_backward_error")?
    } else {
        mode.get("magnetic_block_backward_error")
            .map(|_| required_f64(mode, "magnetic_block_backward_error"))
            .transpose()?
            .unwrap_or(residual)
    };
    let block_residual_phi = if shared_domain_context.is_some() {
        required_f64(mode, "poisson_block_backward_error")?
    } else {
        mode.get("poisson_block_backward_error")
            .map(|_| required_f64(mode, "poisson_block_backward_error"))
            .transpose()?
            .unwrap_or(0.0)
    };
    let block_residual_gauge = if shared_domain_context.is_some() {
        required_f64(mode, "gauge_constraint_backward_error")?
    } else {
        mode.get("gauge_constraint_backward_error")
            .map(|_| required_f64(mode, "gauge_constraint_backward_error"))
            .transpose()?
            .unwrap_or(0.0)
    };
    for (name, value) in [
        ("magnetic_block_backward_error", block_residual_q),
        ("poisson_block_backward_error", block_residual_phi),
        ("gauge_constraint_backward_error", block_residual_gauge),
    ] {
        if value < 0.0 {
            return Err(RunError {
                message: format!("native modal result field '{name}' must be non-negative"),
            });
        }
    }
    let backend_reported_residual = mode
        .get("slepc_reported_backward_error")
        .map(|_| required_f64(mode, "slepc_reported_backward_error"))
        .transpose()?
        .unwrap_or(residual_relative_l2);
    let vector_for_projection = if let Some(context) = shared_domain_context {
        if vector.len() != 2usize.saturating_mul(context.magnetic_class_count) {
            return Err(RunError {
                message:
                    "native shared-domain q vector length does not match reduced magnetic classes"
                        .to_string(),
            });
        }
        let active_count = context.active_nodes.len();
        let mut expanded = vec![Complex64::new(0.0, 0.0); 2usize * active_count];
        for (active_position, node) in context.active_nodes.iter().copied().enumerate() {
            let class = *context.magnetic_classes.get(node).ok_or_else(|| RunError {
                message: "native shared-domain magnetic class map is shorter than the mesh"
                    .to_string(),
            })?;
            if class == u32::MAX || class as usize >= context.magnetic_class_count {
                return Err(RunError {
                    message: "native shared-domain active node has no valid magnetic class"
                        .to_string(),
                });
            }
            expanded[active_position] = vector[class as usize];
            expanded[active_count + active_position] =
                vector[context.magnetic_class_count + class as usize];
        }
        expanded
    } else {
        vector.clone()
    };
    Ok(NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2: residual,
        residual_relative_l2,
        residual_linf: residual,
        mass_norm: complex_block_mass_norm(tangent_mass, &vector).re,
        block_residual_q,
        block_residual_phi,
        block_residual_gauge,
        backend_reported_residual,
        q_vector: vector.clone(),
        phi_vector,
        vector: vector_for_projection,
    })
}

fn native_bloch_floquet_modes_from_result_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    payload: &NativeBlochFloquetDensePayload,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native Bloch/Floquet modal result JSON: {error}"),
    })?;
    let modes = result
        .get("modes")
        .and_then(|value| value.as_array())
        .ok_or_else(|| RunError {
            message: "native Bloch/Floquet modal result JSON is missing modes[]".to_string(),
        })?;
    modes
        .iter()
        .map(|mode| native_bloch_floquet_mode_from_json(plan, mode, payload))
        .collect()
}

fn native_bloch_floquet_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    payload: &NativeBlochFloquetDensePayload,
) -> Result<NativeModalEigenpair, RunError> {
    let real = required_f64_array(mode, "mode_vector_real")?;
    let imag = required_f64_array(mode, "mode_vector_imag")?;
    if real.len() != imag.len() || real.len() != payload.stiffness.nrows() {
        return Err(RunError {
            message: format!(
                "native Bloch/Floquet modal mode vector length mismatch: real={}, imag={}, operator={}",
                real.len(),
                imag.len(),
                payload.stiffness.nrows()
            ),
        });
    }
    let embedded = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
    let mut vector =
        deembed_native_bloch_floquet_mode_vector(&embedded, payload.physical_complex_dof)?;
    vector = normalize_complex_mode(&vector, &payload.physical_mass, &plan.normalization);
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    let lambda = Complex64::new(eigenvalue_real, eigenvalue_imag);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(
            &payload.stiffness,
            &payload.gyrotropic_row_major,
            lambda,
            &embedded,
        );
    let mass_norm = complex_mass_norm(&payload.physical_mass, &vector).re;
    Ok(NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: 0.0,
        backend_reported_residual: residual_relative_l2,
        vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
    })
}

fn native_modal_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    tangent_mass: &DMatrix<f64>,
) -> Result<NativeModalEigenpair, RunError> {
    let real = required_f64_array(mode, "mode_vector_real")?;
    let imag = required_f64_array(mode, "mode_vector_imag")?;
    if real.len() != imag.len() || real.len() != stiffness_omega.nrows() {
        return Err(RunError {
            message: format!(
                "native modal mode vector length mismatch: real={}, imag={}, operator={}",
                real.len(),
                imag.len(),
                stiffness_omega.nrows()
            ),
        });
    }
    let mut vector = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
    normalize_complex_block_mode(&mut vector, tangent_mass, plan.normalization);
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    let lambda = Complex64::new(eigenvalue_real, eigenvalue_imag);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(stiffness_omega, gyrotropic_row_major, lambda, &vector);
    let mass_norm = complex_block_mass_norm(tangent_mass, &vector).re;
    Ok(NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: 0.0,
        backend_reported_residual: residual_relative_l2,
        vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
    })
}

fn validate_native_modal_lambda_frequency_mapping(
    eigenvalue_imag: f64,
    omega_rad_s: f64,
    frequency_hz: f64,
) -> Result<(), RunError> {
    if eigenvalue_imag <= 0.0 {
        return Err(RunError {
            message: format!(
                "native modal lambda=i*omega contract requires a positive-frequency branch, got Im(lambda)={eigenvalue_imag}"
            ),
        });
    }
    let expected_omega = eigenvalue_imag;
    if !approximately_equal(omega_rad_s, expected_omega, 1.0e-9, 1.0e-9) {
        return Err(RunError {
            message: format!(
                "native modal lambda=i*omega contract mismatch: omega_rad_s={omega_rad_s}, Im(lambda)={eigenvalue_imag}"
            ),
        });
    }
    let expected_frequency = expected_omega / std::f64::consts::TAU;
    if !approximately_equal(frequency_hz, expected_frequency, 1.0e-9, 1.0e-9) {
        return Err(RunError {
            message: format!(
                "native modal frequency mapping mismatch: frequency_hz={frequency_hz}, expected Im(lambda)/(2*pi)={expected_frequency}"
            ),
        });
    }
    Ok(())
}

fn approximately_equal(left: f64, right: f64, relative_tol: f64, absolute_tol: f64) -> bool {
    (left - right).abs() <= absolute_tol.max(relative_tol * left.abs().max(right.abs()))
}

fn required_f64(value: &serde_json::Value, key: &str) -> Result<f64, RunError> {
    value
        .get(key)
        .and_then(|field| field.as_f64())
        .filter(|number| number.is_finite())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be finite"),
        })
}

#[allow(dead_code)]
fn required_u64(value: &serde_json::Value, key: &str) -> Result<u64, RunError> {
    value
        .get(key)
        .and_then(|field| field.as_u64())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be an integer"),
        })
}

fn required_f64_array(value: &serde_json::Value, key: &str) -> Result<Vec<f64>, RunError> {
    let array = value
        .get(key)
        .and_then(|field| field.as_array())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be an array"),
        })?;
    array
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| RunError {
                    message: format!("native modal result field '{key}[{index}]' must be finite"),
                })
        })
        .collect()
}

fn normalize_complex_block_mode(
    vector: &mut [Complex64],
    mass: &DMatrix<f64>,
    normalization: EigenNormalizationIR,
) {
    let scale = complex_block_mode_normalization_scale(vector, mass, normalization);
    for value in vector {
        *value /= scale;
    }
}

fn complex_block_mode_normalization_scale(
    vector: &[Complex64],
    mass: &DMatrix<f64>,
    normalization: EigenNormalizationIR,
) -> f64 {
    match normalization {
        EigenNormalizationIR::UnitL2 => complex_block_mass_norm(mass, vector).re.max(0.0).sqrt(),
        EigenNormalizationIR::UnitMaxAmplitude => vector
            .iter()
            .fold(0.0_f64, |acc, value| acc.max(value.norm())),
    }
    .max(1.0e-30)
}

fn complex_block_mass_norm(mass: &DMatrix<f64>, vector: &[Complex64]) -> Complex64 {
    let mut norm = Complex64::new(0.0, 0.0);
    for row in 0..mass.nrows() {
        let mut projected = Complex64::new(0.0, 0.0);
        for col in 0..mass.ncols() {
            projected += vector[col] * mass[(row, col)];
        }
        norm += vector[row].conj() * projected;
    }
    norm
}

fn gyrotropic_pencil_residual_norms(
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    lambda: Complex64,
    vector: &[Complex64],
) -> (f64, f64, f64) {
    let dim = vector.len();
    let mut residual_l2: f64 = 0.0;
    let mut residual_linf: f64 = 0.0;
    let mut k_norm_l2: f64 = 0.0;
    let mut g_norm_l2: f64 = 0.0;
    for row in 0..dim {
        let mut k_row = Complex64::new(0.0, 0.0);
        let mut g_row = Complex64::new(0.0, 0.0);
        for col in 0..dim {
            k_row += vector[col] * stiffness_omega[(row, col)];
            g_row += vector[col] * gyrotropic_row_major[row * dim + col];
        }
        let residual = k_row - lambda * g_row;
        let residual_norm = residual.norm();
        residual_l2 += residual_norm * residual_norm;
        residual_linf = residual_linf.max(residual_norm);
        k_norm_l2 += k_row.norm_sqr();
        g_norm_l2 += g_row.norm_sqr();
    }
    let residual_absolute_l2 = residual_l2.sqrt();
    let denominator = k_norm_l2.sqrt() + lambda.norm() * g_norm_l2.sqrt();
    let residual_relative_l2 = if denominator > 0.0 {
        residual_absolute_l2 / denominator
    } else {
        residual_absolute_l2
    };
    (residual_absolute_l2, residual_relative_l2, residual_linf)
}

fn native_modal_artifacts(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    equilibrium: &[Vector3],
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    modes: &[NativeModalEigenpair],
    node_mass_weights: Option<&[f64]>,
    solver_diagnostics: serde_json::Value,
    relaxation_steps: u64,
    linearization_state: Option<&SharedDomainLinearizationState>,
    relax_to_eigen_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
    sample_index: usize,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let requested_modes = requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    let wants_dispersion = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }));
    let gamma_rad_s_t = plan.gyromagnetic_ratio / MU0;
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let mu0_t_m_per_a = MU0;
    let mut auxiliary_artifacts = Vec::new();
    let mut solver_diagnostics = solver_diagnostics;
    if let Some(object) = solver_diagnostics.as_object_mut() {
        // The native diagnostics payload reports candidate/accepted counts,
        // while artifacts-v2 needs the exact number of modes that survived
        // native reconstruction and are about to be published.  This applies
        // to nearest-target solves as well as frequency-window solves.
        object.insert("mode_count".to_string(), serde_json::json!(modes.len()));
        object.insert(
            "requested_mode_count".to_string(),
            serde_json::json!(plan.count),
        );
    }
    if let Some(state) = linearization_state {
        if let Some(object) = solver_diagnostics.as_object_mut() {
            object.insert(
                "equilibrium_artifact_sha256".to_string(),
                serde_json::json!(state.equilibrium_artifact_digest),
            );
            object.insert(
                "linearization_state_sha256".to_string(),
                serde_json::json!(state.linearization_state_digest),
            );
            object.insert(
                "periodic_mesh_certificate_sha256".to_string(),
                serde_json::json!(state.periodic_mesh_certificate_digest),
            );
            object.insert(
                "linearization_handoff".to_string(),
                serde_json::json!({
                    "equilibrium_artifact_schema": "equilibrium_artifact.v7",
                    "linearization_state_schema": "LinearizationState.v6",
                    "accepted_for_frequency_operator": true,
                }),
            );
        }
    }
    if let Some(handoff) = relax_to_eigen_handoff {
        if let Some(object) = solver_diagnostics.as_object_mut() {
            object.insert(
                "relax_to_eigen_handoff_sha256".to_string(),
                serde_json::json!(handoff.content_sha256()),
            );
            object.insert(
                "source_mesh_topology_sha256".to_string(),
                serde_json::json!(handoff.source_mesh_topology_sha256()),
            );
            object.insert(
                "relax_to_eigen_handoff".to_string(),
                handoff.provenance_json(),
            );
        }
    }
    let sample_diagnostics = solver_diagnostics.clone();
    if let Some(object) = solver_diagnostics.as_object_mut() {
        if !object.contains_key("sample_solver_diagnostics") {
            object.insert(
                "sample_solver_diagnostics".to_string(),
                serde_json::json!([{
                    "sample_index": sample_index,
                    "diagnostics": sample_diagnostics,
                }]),
            );
        }
    }
    // The top-level diagnostics are also the source of the per-sample
    // provenance records consumed by artifacts-v2 validators.  Keep those
    // records synchronized with the exact v6 state files written for this
    // sample; otherwise a single-sample production run can expose the native
    // pre-handoff digest while its published sidecar carries the accepted
    // linearization digest.
    if let Some(state) = linearization_state {
        if let Some(samples) = solver_diagnostics
            .get_mut("sample_solver_diagnostics")
            .and_then(serde_json::Value::as_array_mut)
        {
            for sample in samples {
                let matches_sample = sample
                    .get("sample_index")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|index| index == sample_index as u64);
                if !matches_sample {
                    continue;
                }
                if let Some(nested) = sample
                    .get_mut("diagnostics")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    nested.insert(
                        "equilibrium_artifact_sha256".to_string(),
                        serde_json::json!(state.equilibrium_artifact_digest),
                    );
                    nested.insert(
                        "linearization_state_sha256".to_string(),
                        serde_json::json!(state.linearization_state_digest),
                    );
                    nested.insert(
                        "periodic_mesh_certificate_sha256".to_string(),
                        serde_json::json!(state.periodic_mesh_certificate_digest),
                    );
                }
            }
        }
    }
    if let Some(handoff) = relax_to_eigen_handoff {
        if let Some(samples) = solver_diagnostics
            .get_mut("sample_solver_diagnostics")
            .and_then(serde_json::Value::as_array_mut)
        {
            for sample in samples {
                let matches_sample = sample
                    .get("sample_index")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|index| index == sample_index as u64);
                if !matches_sample {
                    continue;
                }
                if let Some(nested) = sample
                    .get_mut("diagnostics")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    nested.insert(
                        "relax_to_eigen_handoff_sha256".to_string(),
                        serde_json::json!(handoff.content_sha256()),
                    );
                    nested.insert(
                        "source_mesh_topology_sha256".to_string(),
                        serde_json::json!(handoff.source_mesh_topology_sha256()),
                    );
                }
            }
        }
    }
    let mut modes_summary = Vec::with_capacity(modes.len());
    let solver_backend = solver_diagnostics
        .get("solver_backend")
        .and_then(|value| value.as_str())
        .unwrap_or("native_fem_modal_eigen");
    let solver_kind = solver_diagnostics
        .get("solver_model")
        .or_else(|| solver_diagnostics.get("solver_kind"))
        .and_then(|value| value.as_str())
        .unwrap_or("contour_interval_production_cpu_dense");
    let spectral_transform = solver_diagnostics
        .get("spectral_transform")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let execution_lane = solver_diagnostics
        .get("execution_lane")
        .and_then(|value| value.as_str())
        .unwrap_or("production_cpu");
    let participation_context = modal_participation_mesh_context(plan);
    let participation_solver_device = if execution_lane.contains("gpu") {
        "gpu"
    } else {
        "cpu"
    };
    let resolved_solver_family = solver_diagnostics
        .get("resolved_solver_family")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let solver_adapter_name = solver_diagnostics
        .get("solver_adapter")
        .and_then(|value| value.as_str());
    let pa_e2_cpu_periodic_airbox_k0 = matches!(
        solver_adapter_name,
        Some("k0_poisson_airbox_cpu_full_coupled_slepc")
            | Some("k0_poisson_airbox_cpu_schur_slepc")
    );
    let pa_e2_gpu_periodic_airbox_k0 = matches!(
        solver_adapter_name,
        Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    );
    let gpu_scalable_selected_spectrum = solver_diagnostics
        .get("scalable_selected_spectrum")
        .and_then(|value| value.as_bool())
        .unwrap_or(pa_e2_gpu_periodic_airbox_k0);
    let mode_phasor_convention = if pa_e2_cpu_periodic_airbox_k0 {
        "exp_plus_i_omega_t"
    } else {
        "exp_plus_i_omega_t"
    };
    let mode_eigenvalue_mapping = if pa_e2_cpu_periodic_airbox_k0 || pa_e2_gpu_periodic_airbox_k0 {
        "lambda_imag_positive_frequency"
    } else {
        "lambda_eq_i_omega"
    };
    let shift_invert_backend =
        spectral_transform == "shift_invert" || resolved_solver_family == "shift_invert";
    let gpu_k0_backend = pa_e2_gpu_periodic_airbox_k0
        || (execution_lane == "production_gpu" && solver_kind == NATIVE_GPU_K0_KITTEL_SOLVER_KIND);
    let gpu_shared_domain_backend = pa_e2_gpu_periodic_airbox_k0;
    let solver_notes = if gpu_k0_backend {
        if gpu_shared_domain_backend {
            if gpu_scalable_selected_spectrum {
                "native FEM production GPU K0 shared-domain demag modal eigensolver using device-resident Arnoldi/Ritz shift-invert"
            } else {
                "native FEM GPU K0 bounded dense device validation path; scalable selected-spectrum qualification is unavailable"
            }
        } else {
            "native FEM production GPU K0 macrospin modal eigensolver using cuSolverDN dense generalized solve"
        }
    } else if shift_invert_backend {
        "native FEM production CPU modal eigensolver using SLEPc shift-invert"
    } else {
        "native FEM production CPU modal eigensolver using dense contour interval search"
    };
    let solver_capabilities: Vec<&'static str> =
        if gpu_shared_domain_backend && gpu_scalable_selected_spectrum {
            vec![
                "native_modal_eigen",
                "production_gpu",
                "device_resident_krylov",
                "shared_domain_dynamic_demag",
                "k0_periodic_airbox",
            ]
        } else if gpu_shared_domain_backend {
            vec![
                "native_modal_eigen",
                "gpu_device_validation",
                "shared_domain_dynamic_demag",
                "k0_periodic_airbox",
            ]
        } else if gpu_k0_backend {
            vec![
                "native_modal_eigen",
                "production_gpu",
                "cusolverdn_dense",
                "k0_macrospin_validation",
            ]
        } else if shift_invert_backend {
            vec![
                "native_modal_eigen",
                "production_cpu",
                "shift_invert",
                "frequency_window_filter",
            ]
        } else {
            vec![
                "native_modal_eigen",
                "production_cpu",
                "contour_interval",
                "frequency_window_filter",
            ]
        };
    let solver_limitations: Vec<&'static str> =
        if gpu_shared_domain_backend && gpu_scalable_selected_spectrum {
            vec![
                "k0_only",
                "uniform_alpha_zero_scope",
                "anisotropy_and_dmi_tangent_terms_not_certified",
                "frequency_window_completeness_pending",
            ]
        } else if gpu_shared_domain_backend {
            vec![
                "k0_only",
                "uniform_alpha_zero_scope",
                "dense_device_validation_only",
                "scalable_selected_spectrum_unavailable",
            ]
        } else if gpu_k0_backend {
            vec![
                "k0_only",
                "no_demag",
                "macrospin_larmor_validation_slice",
                "nonzero_k_floquet_gpu_modal_not_implemented",
            ]
        } else if shift_invert_backend {
            vec![
                "dense_operator_payload",
                "window_count_certification_pending",
            ]
        } else {
            vec![
                "dense_operator_payload",
                "block_diagonal_2x2_contour_payload",
            ]
        };
    let mut cluster_sizes = BTreeMap::<u64, usize>::new();
    for mode in modes {
        *cluster_sizes.entry(mode.cluster_id).or_default() += 1;
    }

    // Keep the lane-independent operator and lane-specific v6 handoff
    // identities directly on every mode metadata record.  The manifest also
    // carries these values, but per-mode consumers (UI, parity and sidecar
    // validators) must not have to infer provenance through a global file.
    let mode_provenance_value = |key: &str| {
        solver_diagnostics
            .get(key)
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    let mode_operator_input_signature = mode_provenance_value("operator_input_signature_sha256");
    let mode_phase_constraint = mode_provenance_value("phase_constraint_sha256");
    let mode_equilibrium_artifact = mode_provenance_value("equilibrium_artifact_sha256");
    let mode_linearization_state = mode_provenance_value("linearization_state_sha256");
    let mode_periodic_certificate = mode_provenance_value("periodic_mesh_certificate_sha256");
    let mode_relax_to_eigen_handoff = mode_provenance_value("relax_to_eigen_handoff_sha256");
    let mode_source_mesh_topology = mode_provenance_value("source_mesh_topology_sha256");
    let mode_assembly_kind = mode_provenance_value("assembly_kind");

    for (mode_index, mode) in modes.iter().enumerate() {
        let (real, imag, amplitude, phase, max_amplitude) =
            project_complex_2x2_mode_to_tangent_basis(
                equilibrium.len(),
                &reduction.active_nodes,
                &mode.vector,
                bases,
            );
        let norm = mode
            .vector
            .iter()
            .map(|value| value.norm_sqr())
            .sum::<f64>()
            .sqrt();
        let dominant_polarization = classify_polarization(
            &amplitude,
            &reduction.active_nodes,
            equilibrium,
            max_amplitude,
        );
        let (tangent_leakage_mean_abs, tangent_leakage_max_abs) =
            mode_tangent_leakage(equilibrium, &real, &imag);
        let component_participation = modal_participation_for_mode(
            &participation_context,
            plan,
            &real,
            &imag,
            participation_solver_device,
        );
        let q_real = mode
            .q_vector
            .iter()
            .map(|value| value.re)
            .collect::<Vec<_>>();
        let q_imag = mode
            .q_vector
            .iter()
            .map(|value| value.im)
            .collect::<Vec<_>>();
        let phi_real = mode
            .phi_vector
            .iter()
            .map(|value| value.re)
            .collect::<Vec<_>>();
        let phi_imag = mode
            .phi_vector
            .iter()
            .map(|value| value.im)
            .collect::<Vec<_>>();
        let has_native_q_phi_payload = !mode.q_vector.is_empty() || !mode.phi_vector.is_empty();
        let mode_summary = serde_json::json!({
            "index": mode_index,
            "sample_index": sample_index,
            "cluster_id": mode.cluster_id,
            "cluster_size": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
            "multiplicity": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
            "frequency_hz": mode.frequency_hz,
            "frequency_real_hz": mode.frequency_hz,
            "frequency_imag_hz": 0.0,
            "angular_frequency_rad_per_s": mode.omega_rad_s,
            "omega_rad_s": mode.omega_rad_s,
            "angular_frequency_imag_rad_per_s": 0.0,
            "eigenvalue_field_au_per_m": mode.omega_rad_s / plan.gyromagnetic_ratio,
            "eigenvalue_real": mode.eigenvalue_real,
            "eigenvalue_imag": mode.eigenvalue_imag,
            "phasor_convention": mode_phasor_convention,
            "eigenvalue_mapping": mode_eigenvalue_mapping,
            "norm": norm,
            "max_amplitude": max_amplitude,
            "residual_norm": mode.residual_absolute_l2,
            "residual_absolute_l2": mode.residual_absolute_l2,
            "residual_relative_l2": mode.residual_relative_l2,
            "residual_linf": mode.residual_linf,
            "block_residuals": {
                "eps_q": mode.block_residual_q,
                "eps_phi": mode.block_residual_phi,
                "eps_gauge": mode.block_residual_gauge,
                "eps_full": mode.residual_relative_l2,
                "backend_reported_residual": mode.backend_reported_residual,
                "certification_tolerance": 1.0e-8,
                "certified": mode.residual_relative_l2 <= 1.0e-8,
            },
            "mass_norm": mode.mass_norm,
            "q_dof_count": mode.q_vector.len(),
            "phi_dof_count": mode.phi_vector.len(),
            "native_q_phi_payload": has_native_q_phi_payload,
            "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
            "tangent_leakage_max_abs": tangent_leakage_max_abs,
            "gamma_rad_s_T": gamma_rad_s_t,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": mu0_t_m_per_a,
            "dominant_polarization": dominant_polarization,
            "k_vector": k_vector_json(plan.k_sampling.as_ref()),
            "external_field_a_per_m": plan.external_field,
            "assembly_kind": mode_assembly_kind.clone(),
            "operator_input_signature_sha256": mode_operator_input_signature.clone(),
            "phase_constraint_sha256": mode_phase_constraint.clone(),
            "equilibrium_artifact_sha256": mode_equilibrium_artifact.clone(),
            "linearization_state_sha256": mode_linearization_state.clone(),
            "periodic_mesh_certificate_sha256": mode_periodic_certificate.clone(),
            "relax_to_eigen_handoff_sha256": mode_relax_to_eigen_handoff.clone(),
            "source_mesh_topology_sha256": mode_source_mesh_topology.clone(),
            "component_participation": component_participation.clone(),
        });
        modes_summary.push(mode_summary.clone());

        if requested_modes.contains(&(mode_index as u32)) {
            let payload = serde_json::json!({
                "index": mode_index,
                "sample_index": sample_index,
                "frequency_hz": mode.frequency_hz,
                "frequency_real_hz": mode.frequency_hz,
                "frequency_imag_hz": 0.0,
                "angular_frequency_rad_per_s": mode.omega_rad_s,
                "omega_rad_s": mode.omega_rad_s,
                "angular_frequency_imag_rad_per_s": 0.0,
                "eigenvalue_real": mode.eigenvalue_real,
                "eigenvalue_imag": mode.eigenvalue_imag,
                "phasor_convention": mode_phasor_convention,
                "eigenvalue_mapping": mode_eigenvalue_mapping,
                "max_amplitude": max_amplitude,
                "residual_norm": mode.residual_absolute_l2,
                "residual_absolute_l2": mode.residual_absolute_l2,
                "residual_relative_l2": mode.residual_relative_l2,
                "residual_linf": mode.residual_linf,
                "cluster_id": mode.cluster_id,
                "cluster_size": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
                "multiplicity": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
                "block_residuals": {
                    "eps_q": mode.block_residual_q,
                    "eps_phi": mode.block_residual_phi,
                    "eps_gauge": mode.block_residual_gauge,
                    "eps_full": mode.residual_relative_l2,
                    "backend_reported_residual": mode.backend_reported_residual,
                    "certification_tolerance": 1.0e-8,
                    "certified": mode.residual_relative_l2 <= 1.0e-8,
                },
                "mass_norm": mode.mass_norm,
                "q_dof_count": mode.q_vector.len(),
                "phi_dof_count": mode.phi_vector.len(),
                "native_q_phi_payload": has_native_q_phi_payload,
                "q_real": q_real,
                "q_imag": q_imag,
                "phi_real": phi_real,
                "phi_imag": phi_imag,
                "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
                "tangent_leakage_max_abs": tangent_leakage_max_abs,
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
                "normalization": normalization_label(plan.normalization),
                "damping_policy": damping_policy_label(plan.damping_policy),
                "solver_backend": solver_backend,
                "solver_kind": solver_kind,
                "solver_notes": solver_notes,
                "solver_capabilities": solver_capabilities,
                "solver_limitations": solver_limitations,
                "dominant_polarization": dominant_polarization,
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "external_field_a_per_m": plan.external_field,
                "assembly_kind": mode_assembly_kind,
                "operator_input_signature_sha256": mode_operator_input_signature,
                "phase_constraint_sha256": mode_phase_constraint,
                "equilibrium_artifact_sha256": mode_equilibrium_artifact,
                "linearization_state_sha256": mode_linearization_state,
                "periodic_mesh_certificate_sha256": mode_periodic_certificate,
                "relax_to_eigen_handoff_sha256": mode_relax_to_eigen_handoff,
                "source_mesh_topology_sha256": mode_source_mesh_topology,
                "node_mass_weights": node_mass_weights,
                "real": real,
                "imag": imag,
                "amplitude": amplitude,
                "phase": phase,
                "component_participation": component_participation,
            });
            auxiliary_artifacts.push(json_artifact(
                format!("eigen/modes/mode_{mode_index:04}.json"),
                &payload,
            )?);
        }
    }

    let summary_payload = serde_json::json!({
        "study_kind": "eigenmodes",
        "solver_backend": solver_backend,
        "solver_kind": solver_kind,
        "solver_notes": solver_notes,
        "solver_capabilities": solver_capabilities,
        "solver_limitations": solver_limitations,
        "mesh_name": plan.mesh_name,
        "sample_index": sample_index,
        "mode_count": modes_summary.len(),
        "normalization": normalization_label(plan.normalization),
        "damping_policy": damping_policy_label(plan.damping_policy),
        "spin_wave_bc": spin_wave_bc_label(plan.spin_wave_bc.clone()),
        "boundary_config": spin_wave_bc_json(&plan.spin_wave_bc),
        "equilibrium_source": equilibrium_source_json(&plan.equilibrium),
        "included_terms": {
            "exchange": plan.enable_exchange,
            "demag": plan.enable_demag,
            "zeeman": plan.external_field.is_some(),
            "interfacial_dmi": plan.interfacial_dmi.is_some(),
            "bulk_dmi": plan.bulk_dmi.is_some(),
            "surface_anisotropy": plan.spin_wave_bc.surface_anisotropy_ks().is_some(),
        },
        "operator": {
            "kind": format!("{:?}", plan.operator.kind).to_lowercase(),
            "include_demag": plan.operator.include_demag,
        },
        "solver_diagnostics": solver_diagnostics,
        "k_sampling": k_vector_json(plan.k_sampling.as_ref()),
        "node_mass_weights": node_mass_weights,
        "relaxation_steps": relaxation_steps,
        "modes": modes_summary,
    });

    if wants_spectrum {
        auxiliary_artifacts.push(json_artifact("eigen/spectrum.json", &summary_payload)?);
    }
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/eigen_summary.json",
        &summary_payload,
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/normalization.json",
        &serde_json::json!({
            "normalization": normalization_label(plan.normalization),
            "mode_count": summary_payload["mode_count"],
        }),
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/equilibrium_source.json",
        &equilibrium_source_json(&plan.equilibrium),
    )?);
    if let Some(state) = linearization_state {
        auxiliary_artifacts.push(json_artifact(
            "eigen/metadata/equilibrium_artifact.v7.json",
            &state.equilibrium_artifact,
        )?);
        auxiliary_artifacts.push(json_artifact(
            "eigen/metadata/linearization_state.v6.json",
            &state.linearization_state,
        )?);
    }

    if wants_dispersion {
        let visualizable_mode_indices = requested_modes
            .iter()
            .copied()
            .map(u64::from)
            .collect::<BTreeSet<_>>();
        let k_vector = k_vector_json(plan.k_sampling.as_ref());
        auxiliary_artifacts.push(json_artifact(
            "eigen/dispersion/path.json",
            &serde_json::json!({
                "sampling": plan.k_sampling,
                "k_vector": k_vector,
            }),
        )?);
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion/branch_table.csv".to_string(),
            bytes: dispersion_csv(plan.k_sampling.as_ref(), &summary_payload["modes"]).into_bytes(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(
                plan.k_sampling.as_ref(),
                &summary_payload["modes"],
                &visualizable_mode_indices,
            )
            .into_bytes(),
        });
    }
    write_eigen_v2_bundle(
        plan,
        &summary_payload,
        &requested_modes,
        &mut auxiliary_artifacts,
        sample_index,
    )?;
    auxiliary_artifacts
        .retain(|artifact| artifact.relative_path != "eigen/diagnostics/solver.v1.json");
    auxiliary_artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &summary_payload["solver_diagnostics"],
    )?);
    Ok(auxiliary_artifacts)
}

fn execution_provenance(plan: &FemEigenPlanIR, used_gpu: bool) -> ExecutionProvenance {
    let engine = if used_gpu {
        format!("gpu_cusolver_fem_eigen/{}", solver_kind_label(plan))
    } else {
        format!("cpu_baseline_fem_eigen/{}", solver_kind_label(plan))
    };
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: engine,
        // FEM eigen baseline currently executes in double precision.
        precision: "double".to_string(),
        demag_operator_kind: resolved_demag.map(|r| r.provenance_name().to_string()),
        requested_demag_realization: if plan.enable_demag {
            plan.demag_realization
                .map(|requested| demag_realization_label(requested).to_string())
        } else {
            None
        },
        resolved_demag_realization: resolved_demag
            .map(|resolved| demag_realization_label(resolved).to_string()),
        fft_backend: None,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        ..Default::default()
    }
}

fn native_modal_execution_provenance(plan: &FemEigenPlanIR) -> ExecutionProvenance {
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: format!("native_fem_modal_eigen/{NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND}"),
        precision: "double".to_string(),
        demag_operator_kind: resolved_demag.map(|r| r.provenance_name().to_string()),
        requested_demag_realization: if plan.enable_demag {
            plan.demag_realization
                .map(|requested| demag_realization_label(requested).to_string())
        } else {
            None
        },
        resolved_demag_realization: resolved_demag
            .map(|resolved| demag_realization_label(resolved).to_string()),
        fft_backend: None,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        ..Default::default()
    }
}

fn native_gpu_modal_shared_domain_execution_provenance(
    plan: &FemEigenPlanIR,
    attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> ExecutionProvenance {
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: format!(
            "native_fem_modal_eigen/{NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND}"
        ),
        precision: "double".to_string(),
        demag_operator_kind: resolved_demag.map(|r| r.provenance_name().to_string()),
        requested_demag_realization: if plan.enable_demag {
            plan.demag_realization
                .map(|requested| demag_realization_label(requested).to_string())
        } else {
            None
        },
        resolved_demag_realization: resolved_demag
            .map(|resolved| demag_realization_label(resolved).to_string()),
        device_name: attestation.map(|value| value.device_name.clone()),
        compute_capability: attestation.map(|value| {
            format!(
                "{}.{}",
                value.compute_capability_major, value.compute_capability_minor
            )
        }),
        cuda_driver_version: attestation
            .and_then(|value| value.cuda_driver_version.try_into().ok()),
        cuda_runtime_version: attestation
            .and_then(|value| value.cuda_runtime_version.try_into().ok()),
        mfem_version: attestation.map(|value| value.mfem_version.clone()),
        hypre_version: attestation.map(|value| value.hypre_version.clone()),
        fem_execution_mode: attestation.map(|_| "full_gpu_modal_matrix_free".to_string()),
        fem_gpu_qualification_status: attestation.map(|_| "source_visible".to_string()),
        fem_data_residency: attestation.map(|_| "device_source_of_truth".to_string()),
        uses_cuda_kernels: attestation.map(|_| true),
        uses_gpu_poisson: attestation.map(|_| true),
        fem_demag_operator_mode: attestation.map(|_| "poisson_airbox_schur_cuda".to_string()),
        hypre_execution_policy: attestation.map(|_| "device".to_string()),
        demag_residency: attestation.map(|_| "device".to_string()),
        hot_loop_host_sync_count: attestation.map(|value| {
            value.hot_loop_computational_host_syncs + value.hot_loop_scalar_telemetry_syncs
        }),
        hot_loop_compute_h2d_bytes: attestation.map(|value| value.hot_loop_computational_h2d_bytes),
        hot_loop_compute_d2h_bytes: attestation.map(|value| value.hot_loop_computational_d2h_bytes),
        hot_loop_compute_host_sync_count: attestation
            .map(|value| value.hot_loop_computational_host_syncs),
        hot_loop_control_scalar_d2h_bytes: attestation
            .map(|value| value.hot_loop_scalar_telemetry_d2h_bytes),
        hot_loop_control_scalar_host_sync_count: attestation
            .map(|value| value.hot_loop_scalar_telemetry_syncs),
        ..Default::default()
    }
}

fn native_gpu_k0_kittel_execution_provenance(plan: &FemEigenPlanIR) -> ExecutionProvenance {
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: format!("native_fem_modal_eigen/{NATIVE_GPU_K0_KITTEL_SOLVER_KIND}"),
        precision: "double".to_string(),
        demag_operator_kind: resolved_demag.map(|r| r.provenance_name().to_string()),
        requested_demag_realization: if plan.enable_demag {
            plan.demag_realization
                .map(|requested| demag_realization_label(requested).to_string())
        } else {
            None
        },
        resolved_demag_realization: resolved_demag
            .map(|resolved| demag_realization_label(resolved).to_string()),
        fft_backend: None,
        device_name: Some("cuda".to_string()),
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        ..Default::default()
    }
}

fn materialize_equilibrium(
    plan: &FemEigenPlanIR,
    initial_magnetization: &[Vector3],
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
) -> Result<
    (
        FemLlgProblem,
        Vec<Vector3>,
        u64,
        EffectiveFieldObservables,
        Option<LoadedEquilibriumArtifactV7>,
    ),
    RunError,
> {
    let source_artifact = if let EquilibriumSourceIR::Artifact { path } = &plan.equilibrium {
        Some(load_equilibrium_artifact_v7(path, plan.mesh.nodes.len())?)
    } else {
        None
    };
    let equilibrium_guess = source_artifact
        .as_ref()
        .map(|artifact| artifact.m0.clone())
        .unwrap_or_else(|| initial_magnetization.to_vec());

    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("MeshTopology: {}", error),
    })?;
    validate_tangent_frame_transport_support(plan, &topology, &equilibrium_guess)?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|error| RunError {
        message: format!("Material: {}", error),
    })?;
    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::RK23)
        .map_err(|error| RunError {
            message: format!("LLG: {}", error),
        })?
        .with_precession_enabled(false);
    // Compute volume anisotropy field at equilibrium guess so that the
    // relaxation includes the anisotropy contribution.  Because the FEM
    // engine treats per_node_field as static, we recompute it once after
    // an initial relaxation pass (self-consistent field iteration).
    let aniso_per_node: Option<Vec<Vector3>> = {
        let has_uni = plan
            .material
            .uniaxial_anisotropy
            .map_or(false, |k| k.abs() > 0.0);
        let has_cub = plan
            .material
            .cubic_anisotropy_kc1
            .map_or(false, |k| k.abs() > 0.0);
        if has_uni || has_cub {
            Some(
                equilibrium_guess
                    .iter()
                    .map(|m| volume_anisotropy_field(*m, plan))
                    .collect(),
            )
        } else {
            None
        }
    };
    let terms = EffectiveFieldTerms {
        exchange: plan.enable_exchange,
        demag: plan.enable_demag,
        external_field: plan.external_field,
        per_node_field: aniso_per_node,
        magnetoelastic: None,
        uniaxial_anisotropy: None,
        cubic_anisotropy: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        zhang_li_stt: None,
        slonczewski_stt: None,
        sot: None,
        oersted_cylinder: None,
    };
    let resolved_demag = resolved_demag_realization(plan);
    let robin_beta_factor = if matches!(
        resolved_demag,
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
    ) {
        shared_domain_robin_beta_m(plan)?.map(|beta| beta / topology.robin_beta)
    } else {
        None
    };
    let mut problem = match resolved_demag {
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology,
                material,
                dynamics,
                terms,
                false,
                robin_beta_factor,
            )
        }
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology, material, dynamics, terms, true, None,
            )
        }
        Some(r) => {
            return Err(RunError {
                message: format!(
                    "FEM eigen runner: demag model '{}' is not yet implemented",
                    r.model_name(),
                ),
            });
        }
        None => FemLlgProblem::with_terms(topology, material, dynamics, terms),
    };
    if let Some(normal) = plan.dmi_interface_normal {
        problem.set_dmi_interface_normal(normal);
    }
    let state = problem
        .new_state(equilibrium_guess)
        .map_err(|error| RunError {
            message: format!("State: {}", error),
        })?;

    let steps_taken = 0;

    let mut observables = problem.observe(&state).map_err(|error| RunError {
        message: format!("FEM eigen observables: {}", error),
    })?;
    if let Some(handoff) = source_relax_handoff {
        validate_certified_equilibrium_fields(
            &handoff.certified_fields,
            state.magnetization().len(),
        )?;
        observables.magnetization = state.magnetization().to_vec();
        observables.exchange_field = handoff.certified_fields.h_ex_a_per_m.clone();
        observables.demag_field = handoff.certified_fields.h_demag_a_per_m.clone();
        observables.external_field = handoff.certified_fields.h_ext_a_per_m.clone();
        observables.effective_field = handoff.certified_fields.h_eff_a_per_m.clone();
        observables.max_effective_field_amplitude = observables
            .effective_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        observables.max_demag_field_amplitude = observables
            .demag_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        observables.max_torque_Apm = observables
            .magnetization
            .iter()
            .zip(&observables.effective_field)
            .map(|(m, h)| vector_norm(cross(*m, *h)))
            .fold(0.0_f64, f64::max);
    }
    if std::env::var_os("FULLMAG_TRACE_CONTINUATION").is_some() {
        let max_exchange = observables
            .exchange_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        let max_demag = observables
            .demag_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        let max_external = observables
            .external_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        eprintln!(
            "[fullmag-trace] materialize-equilibrium: max_torque_apm={:.6e} max_h_eff_apm={:.6e} max_torque_relative={:.6e} max_exchange={:.6e} max_demag={:.6e} max_external={:.6e} steps={}",
            observables.max_torque_Apm,
            observables.max_effective_field_amplitude,
            observables.max_torque_Apm
                / observables.max_effective_field_amplitude.max(1.0),
            max_exchange,
            max_demag,
            max_external,
            steps_taken,
        );
    }
    let equilibrium = if source_relax_handoff.is_some() {
        let normalization_delta = max_vector_field_difference(
            state.magnetization(),
            initial_magnetization,
        )
        .unwrap_or(f64::INFINITY);
        if !normalization_delta.is_finite() || normalization_delta > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_equilibrium_normalization_drift: state normalization changed the accepted m0 by {normalization_delta:.3e}"
                ),
            });
        }
        // FemLlgState normalizes each vector on construction.  The accepted
        // relaxation handoff is a stronger identity contract than that
        // internal representation: preserve its exact m0 for stage
        // continuation while using the normalized state for observations.
        initial_magnetization.to_vec()
    } else {
        state.magnetization().to_vec()
    };

    Ok((problem, equilibrium, steps_taken, observables, source_artifact))
}

fn load_equilibrium_artifact_v7(
    path: &str,
    expected_len: usize,
) -> Result<LoadedEquilibriumArtifactV7, RunError> {
    let raw = std::fs::read_to_string(path).map_err(|error| RunError {
        message: format!("failed to read equilibrium artifact '{}': {}", path, error),
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| RunError {
        message: format!("failed to parse equilibrium artifact '{}': {}", path, error),
    })?;
    let object = value.as_object().ok_or_else(|| RunError {
        message: format!(
            "equilibrium artifact '{}' must be a certified equilibrium_artifact.v7 object; raw vector payloads are rejected",
            path
        ),
    })?;
    let required_string = |name: &str| -> Result<&str, RunError> {
        object
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' is missing required v7 field '{}'",
                    path, name
                ),
            })
    };
    let schema_version = required_string("schema_version")?;
    if schema_version == "equilibrium_artifact.v6" {
        return Err(RunError {
            message: "equilibrium_artifact_v6_uncertified: rerun relaxation or migrate with source completion evidence"
                .to_string(),
        });
    }
    if schema_version != "equilibrium_artifact.v7" {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' must use schema equilibrium_artifact.v7",
                path
            ),
        });
    }
    if object
        .get("accepted_for_linearization")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' is not accepted for linearization",
                path
            ),
        });
    }
    for name in [
        "producer_run_id",
        "content_sha256",
        "equilibrium_id",
        "mesh_signature",
        "material_signature",
        "physics_signature",
        "boundary_signature",
        "static_demag_signature",
    ] {
        required_string(name)?;
    }
    let declared_content_sha256 = required_string("content_sha256")?.to_string();
    let declared_equilibrium_id = required_string("equilibrium_id")?.to_string();
    let mut digest_payload = value.clone();
    let digest_object = digest_payload
        .as_object_mut()
        .expect("the equilibrium artifact object was validated above");
    digest_object.remove("content_sha256");
    digest_object.remove("equilibrium_id");
    let recomputed_content_sha256 =
        shared_domain_content_digest("equilibrium_artifact_v7", &digest_payload)?;
    let expected_equilibrium_id = format!(
        "equilibrium_artifact.v7:{}",
        recomputed_content_sha256
            .strip_prefix("sha256:")
            .unwrap_or(&recomputed_content_sha256)
    );
    if declared_content_sha256 != recomputed_content_sha256
        || declared_equilibrium_id != expected_equilibrium_id
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has mismatched content_sha256 or equilibrium_id",
                path
            ),
        });
    }
    let acceptance_object = object
        .get("acceptance_certificate")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing acceptance_certificate",
                path
            ),
        })?;
    let certificate_string = |name: &str| -> Result<&str, RunError> {
        acceptance_object
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' has invalid acceptance_certificate.{}",
                    path, name
                ),
            })
    };
    let criterion = certificate_string("criterion")?;
    let metric_kind = certificate_string("metric_kind")?;
    let unit = certificate_string("unit")?;
    let stop_reason = certificate_string("stop_reason")?;
    let coherent_certificate = matches!(
        (criterion, metric_kind, unit, stop_reason),
        ("torque", "max_torque_apm", "A/m", "torque")
            | ("energy", "total_energy_plateau_range_j", "J", "energy")
    );
    let metric_value = acceptance_object
        .get("metric_value")
        .and_then(serde_json::Value::as_f64);
    let threshold = acceptance_object
        .get("threshold")
        .and_then(serde_json::Value::as_f64);
    if !coherent_certificate
        || acceptance_object
            .get("status")
            .and_then(serde_json::Value::as_str)
            != Some("completed")
        || acceptance_object
            .get("converged")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || !matches!((metric_value, threshold), (Some(value), Some(limit)) if value.is_finite() && limit.is_finite() && limit >= 0.0 && value <= limit)
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has an invalid or unsatisfied acceptance_certificate",
                path
            ),
        });
    }
    let completion_sha256 = certificate_string("completion_sha256")?;
    if !is_sha256_digest(completion_sha256)
        || object
            .get("completion_sha256")
            .and_then(serde_json::Value::as_str)
            != Some(completion_sha256)
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has mismatched completion_sha256",
                path
            ),
        });
    }
    let acceptance_certificate: AcceptedEquilibriumCriterion = serde_json::from_value(
        serde_json::Value::Object(acceptance_object.clone()),
    )
    .map_err(|error| RunError {
        message: format!(
            "equilibrium artifact '{}' has invalid acceptance_certificate: {}",
            path, error
        ),
    })?;
    let observables = object
        .get("observables")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!("equilibrium artifact '{}' is missing observables", path),
        })?;
    for name in ["max_torque_Apm", "max_torque_T", "max_torque_relative"] {
        if observables
            .get(name)
            .and_then(serde_json::Value::as_f64)
            .is_none_or(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "equilibrium artifact '{}' has invalid observable '{}'",
                    path, name
                ),
            });
        }
    }
    let representation_integrity = object
        .get("representation_integrity")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing representation_integrity",
                path
            ),
        })?;
    let m0_norm_tolerance = representation_integrity
        .get("m0_norm_tolerance")
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' has invalid representation_integrity.m0_norm_tolerance",
                path
            ),
        })?;
    let parse_vector_field = |name: &str| -> Result<Vec<Vector3>, RunError> {
        let values = object
            .get(name)
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' is missing required v7 field '{}'",
                    path, name
                ),
            })?;
        if values.len() != expected_len {
            return Err(RunError {
                message: format!(
                    "equilibrium artifact '{}' has invalid '{}' vector field",
                    path, name
                ),
            });
        }
        values
            .iter()
            .map(|entry| {
                let vector = entry.as_array().ok_or_else(|| RunError {
                    message: format!(
                        "equilibrium artifact '{}' has invalid '{}' vector field",
                        path, name
                    ),
                })?;
                if vector.len() != 3
                    || vector
                        .iter()
                        .any(|value| value.as_f64().is_none_or(|value| !value.is_finite()))
                {
                    return Err(RunError {
                        message: format!(
                            "equilibrium artifact '{}' has invalid '{}' vector field",
                            path, name
                        ),
                    });
                }
                Ok([
                    vector[0].as_f64().unwrap(),
                    vector[1].as_f64().unwrap(),
                    vector[2].as_f64().unwrap(),
                ])
            })
            .collect()
    };
    let h_eff0 = parse_vector_field("h_eff0_a_per_m")?;
    let h_demag0 = parse_vector_field("h_demag0_a_per_m")?;
    let phi0_requirement = required_string("phi0_requirement")?;
    if phi0_requirement != "required_for_restart_or_provenance" {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has unsupported phi0_requirement '{}'",
                path, phi0_requirement
            ),
        });
    }
    let phi0_values = object
        .get("phi0")
        .or_else(|| object.get("phi0_a"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing required v6 phi0",
                path
            ),
        })?;
    if phi0_values.is_empty()
        || phi0_values
            .iter()
            .any(|value| value.as_f64().is_none_or(|value| !value.is_finite()))
    {
        return Err(RunError {
            message: format!("equilibrium artifact '{}' has invalid phi0", path),
        });
    }
    let certificate = object
        .get("periodic_mesh_certificate")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing periodic mesh certificate",
                path
            ),
        })?;
    for name in ["certificate_id", "content_sha256"] {
        if certificate
            .get(name)
            .and_then(serde_json::Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(RunError {
                message: format!(
                    "equilibrium artifact '{}' has incomplete periodic mesh certificate",
                    path
                ),
            });
        }
    }
    if certificate
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
        != Some("periodic_mesh_certificate.v6")
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' requires periodic_mesh_certificate.v6",
                path
            ),
        });
    }
    if certificate
        .get("certificate")
        .and_then(serde_json::Value::as_object)
        .is_none()
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has no complete periodic mesh certificate payload",
                path
            ),
        });
    }
    let certificate_id = certificate["certificate_id"].as_str().unwrap();
    let certificate_hash = certificate["content_sha256"].as_str().unwrap();
    let expected_certificate_id = format!(
        "periodic_mesh_certificate.v6:{}",
        certificate_hash.strip_prefix("sha256:").unwrap_or("")
    );
    if certificate_id != expected_certificate_id {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has mismatched periodic mesh certificate identity",
                path
            ),
        });
    }
    let m0 = parse_vector_field("m0")?;
    let phi0 = phi0_values
        .iter()
        .map(|value| value.as_f64().unwrap())
        .collect::<Vec<_>>();
    let required_string_owned = |name: &str| required_string(name).map(str::to_string);
    let periodic_mesh_certificate = object
        .get("periodic_mesh_certificate")
        .cloned()
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing periodic mesh certificate",
                path
            ),
        })?;
    Ok(LoadedEquilibriumArtifactV7 {
        value: value.clone(),
        m0,
        h_eff0,
        h_demag0,
        phi0,
        equilibrium_id: required_string_owned("equilibrium_id")?,
        producer_run_id: required_string_owned("producer_run_id")?,
        content_sha256: required_string_owned("content_sha256")?,
        mesh_signature: required_string_owned("mesh_signature")?,
        material_signature: required_string_owned("material_signature")?,
        physics_signature: required_string_owned("physics_signature")?,
        boundary_signature: required_string_owned("boundary_signature")?,
        static_demag_signature: required_string_owned("static_demag_signature")?,
        demag_model: object
            .get("demag_model")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("poisson_robin")
            .to_string(),
        m0_norm_tolerance,
        phi0_requirement: phi0_requirement.to_string(),
        periodic_mesh_certificate,
        acceptance_certificate,
        completion_sha256: completion_sha256.to_string(),
    })
}

fn load_equilibrium_artifact(path: &str, expected_len: usize) -> Result<Vec<Vector3>, RunError> {
    Ok(load_equilibrium_artifact_v7(path, expected_len)?.m0)
}

fn build_reduction_map(
    topology: &MeshTopology,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    k_sampling: Option<&KSamplingIR>,
) -> Result<ReductionMap, RunError> {
    let pinned: std::collections::HashSet<usize> =
        if matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Pinned) {
            magnetic_boundary_nodes(topology)
        } else {
            std::collections::HashSet::new()
        };

    let phase_groups = phase_reduction(topology, spin_wave_bc, k_sampling)?;

    let mut active_nodes = Vec::new();
    let mut mapping = vec![None; topology.n_nodes];
    let mut node_phases = vec![Complex64::new(1.0, 0.0); topology.n_nodes];

    if let Some(groups) = phase_groups {
        let mut root_to_reduced = std::collections::BTreeMap::new();
        for (node_index, volume) in topology.magnetic_node_volumes.iter().enumerate() {
            if *volume <= 0.0 || pinned.contains(&node_index) {
                continue;
            }
            let root = groups.roots[node_index];
            let reduced_index = if let Some(existing) = root_to_reduced.get(&root) {
                *existing
            } else {
                let next = active_nodes.len();
                root_to_reduced.insert(root, next);
                active_nodes.push(root);
                next
            };
            mapping[node_index] = Some(reduced_index);
            node_phases[node_index] = groups.phases[node_index];
        }
        Ok(ReductionMap {
            active_nodes,
            node_map: mapping,
            node_phases,
            complex_reduction: matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet)
                && !is_gamma_k_sampling(k_sampling),
        })
    } else {
        for (node_index, volume) in topology.magnetic_node_volumes.iter().enumerate() {
            if *volume <= 0.0 || pinned.contains(&node_index) {
                continue;
            }
            let reduced_index = active_nodes.len();
            active_nodes.push(node_index);
            mapping[node_index] = Some(reduced_index);
        }
        Ok(ReductionMap {
            active_nodes,
            node_map: mapping,
            node_phases,
            complex_reduction: false,
        })
    }
}

fn is_gamma_k_sampling(k_sampling: Option<&KSamplingIR>) -> bool {
    match k_sampling {
        None => true,
        Some(KSamplingIR::Single { k_vector }) => k_vector.iter().all(|value| *value == 0.0),
        Some(KSamplingIR::Path { points, .. }) => {
            !points.is_empty()
                && points
                    .iter()
                    .all(|point| point.k_vector.iter().all(|value| *value == 0.0))
        }
    }
}

fn k_sampling_contains_nonzero(k_sampling: Option<&KSamplingIR>) -> bool {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => k_vector.iter().any(|value| *value != 0.0),
        Some(KSamplingIR::Path { points, .. }) => points
            .iter()
            .any(|point| point.k_vector.iter().any(|value| *value != 0.0)),
        None => false,
    }
}

fn validate_tangent_frame_transport_support(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    equilibrium: &[Vector3],
) -> Result<(), RunError> {
    let kind = plan.spin_wave_bc.kind();
    if !matches!(
        kind,
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) || topology.periodic_node_pairs.is_empty()
    {
        return Ok(());
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected_pairs.is_empty() {
        return Ok(());
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        return Ok(());
    }
    reject_nonidentity_tangent_frame_transport(topology, &selected_pairs, equilibrium)
}

#[derive(Debug, Clone)]
struct PhaseGroups {
    roots: Vec<usize>,
    phases: Vec<Complex64>,
}

fn phase_reduction(
    topology: &MeshTopology,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    k_sampling: Option<&KSamplingIR>,
) -> Result<Option<PhaseGroups>, RunError> {
    let kind = spin_wave_bc.kind();
    if !matches!(
        kind,
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return Ok(None);
    }
    if topology.periodic_node_pairs.is_empty() {
        return Err(RunError {
            message: format!(
                "spin_wave_bc.kind='{kind}' requires mesh.periodic_node_pairs metadata — \
                 the mesh contains no periodic node pairs; add periodic_node_pairs to the mesh IR \
                 or use spin_wave_bc.kind='free'",
                kind = match kind {
                    SpinWaveBoundaryKindIR::Periodic => "periodic",
                    _ => "floquet",
                }
            ),
        });
    }

    let requested_pair_ids = spin_wave_bc.boundary_pair_ids();
    let k_vector = match (kind, k_sampling) {
        (SpinWaveBoundaryKindIR::Floquet, Some(KSamplingIR::Single { k_vector })) => {
            Some(*k_vector)
        }
        (SpinWaveBoundaryKindIR::Floquet, Some(KSamplingIR::Path { .. })) => {
            return Err(RunError {
                message: "floquet spin-wave BC with KSampling::Path is not yet supported in single-k runner; use the multi-k orchestrator".to_string(),
            });
        }
        (SpinWaveBoundaryKindIR::Floquet, None) => {
            return Err(RunError {
                message: "floquet spin-wave BC requires k_sampling=Single{...}".to_string(),
            });
        }
        _ => None,
    };

    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected_pairs.is_empty() {
        return Err(RunError {
            message: format!(
                "spin_wave_bc.kind='{}' did not match any mesh.periodic_node_pairs pair_id",
                spin_wave_bc_label(spin_wave_bc.clone())
            ),
        });
    }
    let dof_map = if let Some(k) = k_vector {
        PeriodicDofMap::from_periodic_pair_tuples_floquet(
            topology.n_nodes,
            &selected_pairs,
            &topology.periodic_boundary_pairs,
            &topology.coords,
            k,
            spin_wave_bc.phase_convention(),
        )
    } else {
        PeriodicDofMap::from_periodic_pair_tuples_static(topology.n_nodes, &selected_pairs)
    }
    .map_err(|error| RunError {
        message: format!("failed to build periodic DOF map: {}", error.message),
    })?;

    let roots = (0..topology.n_nodes)
        .map(|node| dof_map.representative_nodes[dof_map.reduced_node(node)])
        .collect::<Vec<_>>();
    let phases = (0..topology.n_nodes)
        .map(|node| {
            let phase = dof_map.phase(node);
            Complex64::new(phase.re, phase.im)
        })
        .collect::<Vec<_>>();

    Ok(Some(PhaseGroups { roots, phases }))
}

fn reject_nonidentity_tangent_frame_transport(
    topology: &MeshTopology,
    selected_pairs: &[(String, u32, u32)],
    equilibrium: &[Vector3],
) -> Result<(), RunError> {
    if equilibrium.len() < topology.n_nodes {
        return Err(RunError {
            message: format!(
                "periodic/Floquet modal tangent-frame transport cannot be validated: \
                 equilibrium has {} nodes but mesh has {} nodes",
                equilibrium.len(),
                topology.n_nodes
            ),
        });
    }
    let bases = tangent_bases(equilibrium);
    let mut max_mismatch: f64 = 0.0;
    let mut worst_pair: Option<(&str, usize, usize)> = None;
    for (pair_id, node_a, node_b) in selected_pairs {
        let node_a = *node_a as usize;
        let node_b = *node_b as usize;
        if topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let mismatch = tangent_frame_identity_mismatch(bases[node_a], bases[node_b]);
        if mismatch > max_mismatch {
            max_mismatch = mismatch;
            worst_pair = Some((pair_id.as_str(), node_a, node_b));
        }
    }
    if max_mismatch > TANGENT_FRAME_IDENTITY_TOLERANCE {
        let (pair_id, node_a, node_b) = worst_pair.unwrap_or(("unknown", 0, 0));
        return Err(RunError {
            message: format!(
                "periodic/Floquet modal tangent-frame transport requires full \
                 phase*(T_dst^T T_src) support; the current reference runner only \
                 supports identity tangent-frame transport. pair_id='{pair_id}' \
                 node_a={node_a} node_b={node_b} \
                 tangent_frame_mismatch={max_mismatch:.6e} \
                 tolerance={TANGENT_FRAME_IDENTITY_TOLERANCE:.6e}"
            ),
        });
    }
    Ok(())
}

fn tangent_frame_identity_mismatch(src: (Vector3, Vector3), dst: (Vector3, Vector3)) -> f64 {
    let transport = tangent_transport_matrix(src, dst);
    ((transport[0][0] - 1.0).powi(2)
        + transport[0][1].powi(2)
        + transport[1][0].powi(2)
        + (transport[1][1] - 1.0).powi(2))
    .sqrt()
}

fn tangent_transport_matrix(src: (Vector3, Vector3), dst: (Vector3, Vector3)) -> [[f64; 2]; 2] {
    let (src_e1, src_e2) = src;
    let (dst_e1, dst_e2) = dst;
    [
        [dot(dst_e1, src_e1), dot(dst_e1, src_e2)],
        [dot(dst_e2, src_e1), dot(dst_e2, src_e2)],
    ]
}

fn tangent_transport_nonunitarity(transport: [[f64; 2]; 2]) -> f64 {
    let c00 = transport[0][0] * transport[0][0] + transport[1][0] * transport[1][0];
    let c01 = transport[0][0] * transport[0][1] + transport[1][0] * transport[1][1];
    let c10 = transport[0][1] * transport[0][0] + transport[1][1] * transport[1][0];
    let c11 = transport[0][1] * transport[0][1] + transport[1][1] * transport[1][1];
    ((c00 - 1.0).powi(2) + c01.powi(2) + c10.powi(2) + (c11 - 1.0).powi(2)).sqrt()
}

fn tangent_transport_to_root(
    node: usize,
    root: usize,
    bases: &[(Vector3, Vector3)],
) -> [[f64; 2]; 2] {
    let (node_e1, node_e2) = bases[node];
    let (root_e1, root_e2) = bases[root];
    [
        [dot(node_e1, root_e1), dot(node_e1, root_e2)],
        [dot(node_e2, root_e1), dot(node_e2, root_e2)],
    ]
}

fn project_local_tangent_block_to_reduced(
    coeff: Complex64,
    row_transport: [[f64; 2]; 2],
    local_block: [[f64; 2]; 2],
    col_transport: [[f64; 2]; 2],
) -> [[Complex64; 2]; 2] {
    let mut reduced = [[Complex64::new(0.0, 0.0); 2]; 2];
    for row_component in 0..2 {
        for col_component in 0..2 {
            let mut value = 0.0;
            for local_row in 0..2 {
                for local_col in 0..2 {
                    value += row_transport[local_row][row_component]
                        * local_block[local_row][local_col]
                        * col_transport[local_col][col_component];
                }
            }
            reduced[row_component][col_component] = coeff * value;
        }
    }
    reduced
}

fn add_complex_tangent_block(
    matrix: &mut [Vec<Complex64>],
    n: usize,
    row: usize,
    col: usize,
    block: [[Complex64; 2]; 2],
) {
    matrix[row][col] += block[0][0];
    matrix[row][col + n] += block[0][1];
    matrix[row + n][col] += block[1][0];
    matrix[row + n][col + n] += block[1][1];
}

/// Returns the set of indices of nodes that lie on the surface of the magnetic
/// region (i.e. surface relevant for spin-wave pinning BC).
///
/// * Standalone magnetic mesh (no airbox):  
///   `topology.boundary_nodes` are all on the outer surface of the magnet.
///
/// * Shared-domain mesh with airbox:  
///   `topology.boundary_nodes` are on the outer airbox surface, NOT the magnet
///   surface.  We instead find nodes that are magnetic AND appear in at least
///   one non-magnetic (airbox) element — these are exactly on the interface.
fn magnetic_boundary_nodes(topology: &MeshTopology) -> std::collections::HashSet<usize> {
    let has_airbox = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| !is_magnetic);

    if !has_airbox {
        // Standalone magnetic mesh: outer boundary = magnet surface.
        return topology
            .boundary_nodes
            .iter()
            .map(|&n| n as usize)
            .collect();
    }

    // Shared-domain mesh: collect nodes that appear in non-magnetic elements.
    let mut in_airbox_element: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (element_idx, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_idx] {
            for &node in element.iter() {
                in_airbox_element.insert(node as usize);
            }
        }
    }
    // Magnetic boundary = magnetic nodes that are also in an airbox element.
    (0..topology.n_nodes)
        .filter(|&i| topology.magnetic_node_volumes[i] > 0.0 && in_airbox_element.contains(&i))
        .collect()
}

fn assemble_projected_scalar_operator_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
) -> AssembledScalarOperator {
    let active_count = reduction.active_nodes.len();
    let mut stiffness = DMatrix::<f64>::zeros(active_count, active_count);
    let mut mass = DMatrix::<f64>::zeros(active_count, active_count);
    let exchange_coeff = exchange_field_coefficient(plan);
    let parallel_field = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let mut selected_field = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                selected_field = add_vector(selected_field, observables.exchange_field[index]);
            }
            if plan.enable_demag {
                selected_field = add_vector(selected_field, observables.demag_field[index]);
            }
            if plan.external_field.is_some() {
                selected_field = add_vector(selected_field, observables.external_field[index]);
            }
            // Volume anisotropy (uniaxial + cubic) contribution to parallel field
            selected_field = add_vector(selected_field, volume_anisotropy_field(*m, plan));
            dot(*m, selected_field).max(0.0)
        })
        .collect::<Vec<_>>();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        let local_shift = [
            parallel_field[element[0] as usize],
            parallel_field[element[1] as usize],
            parallel_field[element[2] as usize],
            parallel_field[element[3] as usize],
        ];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                mass[(row, col)] += local_mass[i][j];
                if plan.enable_exchange {
                    stiffness[(row, col)] +=
                        exchange_coeff * topology.element_stiffness[element_index][i][j];
                }
                let shift = 0.5 * (local_shift[i] + local_shift[j]);
                stiffness[(row, col)] += local_mass[i][j] * shift;
            }
        }
    }

    add_surface_anisotropy_real(plan, topology, reduction, equilibrium, &mut stiffness);
    add_dmi_real(plan, topology, reduction, &mut stiffness);

    AssembledScalarOperator::new(stiffness, mass)
}

/// Assemble the full 2×2 Herring–Kittel block operator.
///
/// The operator is 2N × 2N with blocks:
/// ```text
///   K = [ K_11  K_12 ]    M_block = [ M  0 ]
///       [ K_21  K_22 ]              [ 0  M ]
/// ```
///
/// Block layout: rows/cols [0..N) correspond to the e1 tangent component,
/// rows/cols [N..2N) correspond to the e2 tangent component.
///
/// For exchange: the exchange stiffness is isotropic in the tangent plane,
/// so it contributes equally to K_11 and K_22 diagonals and does NOT couple
/// K_12/K_21.
///
/// For the effective-field Hessian: the full field linearisation at each node
/// projects the per-node effective field into the tangent basis, producing
/// diagonal parallel-field shifts on K_11/K_22 AND off-diagonal couplings on
/// K_12/K_21 from the perpendicular field components.
fn assemble_tangent_mass_matrix(topology: &MeshTopology, reduction: &ReductionMap) -> DMatrix<f64> {
    let n = reduction.active_nodes.len();
    let mut mass = DMatrix::<f64>::zeros(2 * n, 2 * n);
    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                let value = if i == j {
                    2.0 * volume / 20.0
                } else {
                    volume / 20.0
                };
                mass[(row, col)] += value;
                mass[(row + n, col + n)] += value;
            }
        }
    }
    mass
}

fn assemble_full_2x2_operator_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
    bases: &[(Vector3, Vector3)],
) -> (DMatrix<f64>, DMatrix<f64>) {
    let n = reduction.active_nodes.len();
    let dim = 2 * n;
    let mut stiffness = DMatrix::<f64>::zeros(dim, dim);
    let mass = assemble_tangent_mass_matrix(topology, reduction);
    let exchange_coeff = exchange_field_coefficient(plan);

    // Compute local effective-field tangent-plane projection at each node.
    // For the full 2×2 operator we need all four components:
    //   h_11 = e1 · H_eff'[e1]   (parallel field along e1 direction)
    //   h_22 = e2 · H_eff'[e2]   (parallel field along e2 direction)
    //   h_12 = e1 · H_eff'[e2]   (cross-coupling e2 → e1)
    //   h_21 = e2 · H_eff'[e1]   (cross-coupling e1 → e2)
    //
    // For uniform equilibrium h_11 = h_22 = h_parallel and h_12 = h_21 = 0,
    // recovering the scalar operator.
    let field_blocks: Vec<[f64; 4]> = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let mut h_eff = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                h_eff = add_vector(h_eff, observables.exchange_field[idx]);
            }
            if plan.enable_demag {
                h_eff = add_vector(h_eff, observables.demag_field[idx]);
            }
            if plan.external_field.is_some() {
                h_eff = add_vector(h_eff, observables.external_field[idx]);
            }
            h_eff = add_vector(h_eff, volume_anisotropy_field(*m, plan));

            let (e1, e2) = bases[idx];
            // Project effective field into tangent basis.
            // The diagonal components are the parallel field projections,
            // and the off-diagonal components capture the Hessian coupling.
            let h_parallel = dot(*m, h_eff).max(0.0);
            // For the cross terms, we project H_eff components perpendicular to m₀.
            // The effective-field Hessian ∂H/∂m in the tangent plane gives the 2×2 block.
            // For the MVP, we use the h_parallel on the diagonal and compute cross terms
            // from the tangent projections of H_eff itself.
            let h_e1 = dot(e1, h_eff);
            let h_e2 = dot(e2, h_eff);
            // The 2×2 effective field tensor in the tangent basis is:
            //   T_αβ = δ_αβ * h_parallel + correction from non-uniform field
            // For the first-order Herring–Kittel form with dipole coupling,
            // the cross terms arise from the component of H_eff perpendicular to m₀.
            // In the uniform case h_e1 = h_e2 = 0, so the off-diagonal vanishes.
            [
                h_parallel,                            // h_11
                h_e1 * h_e2 / (h_parallel.max(1e-30)), // h_12 (cross coupling)
                h_e1 * h_e2 / (h_parallel.max(1e-30)), // h_21 = h_12 (symmetric)
                h_parallel,                            // h_22
            ]
        })
        .collect();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        for i in 0..4 {
            let node_i = element[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let m_ij = local_mass[i][j];
                let fb_i = &field_blocks[node_i];
                let fb_j = &field_blocks[node_j];

                // Exchange stiffness: isotropic → K_11 and K_22 only
                if plan.enable_exchange {
                    let ex = exchange_coeff * topology.element_stiffness[element_index][i][j];
                    stiffness[(row, col)] += ex;
                    stiffness[(row + n, col + n)] += ex;
                }

                // Field shift contribution (averaged between nodes i and j):
                // K_11: h_11 shift
                let h11 = 0.5 * (fb_i[0] + fb_j[0]);
                stiffness[(row, col)] += m_ij * h11;

                // K_22: h_22 shift
                let h22 = 0.5 * (fb_i[3] + fb_j[3]);
                stiffness[(row + n, col + n)] += m_ij * h22;

                // K_12: cross-coupling e2 → e1
                let h12 = 0.5 * (fb_i[1] + fb_j[1]);
                stiffness[(row, col + n)] += m_ij * h12;

                // K_21: cross-coupling e1 → e2
                let h21 = 0.5 * (fb_i[2] + fb_j[2]);
                stiffness[(row + n, col)] += m_ij * h21;
            }
        }
    }

    // Apply surface anisotropy to both diagonal blocks
    add_surface_anisotropy_2x2(plan, topology, reduction, equilibrium, &mut stiffness, n);
    // Apply DMI to both diagonal blocks
    add_dmi_2x2(plan, topology, reduction, &mut stiffness, n);

    (stiffness, mass)
}

fn assemble_projected_scalar_operator_complex(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
) -> (Vec<Vec<Complex64>>, Vec<Vec<Complex64>>) {
    let active_count = reduction.active_nodes.len();
    let mut stiffness = vec![vec![Complex64::new(0.0, 0.0); active_count]; active_count];
    let mut mass = vec![vec![Complex64::new(0.0, 0.0); active_count]; active_count];
    let exchange_coeff = exchange_field_coefficient(plan);
    let parallel_field = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let mut selected_field = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                selected_field = add_vector(selected_field, observables.exchange_field[index]);
            }
            if plan.enable_demag {
                selected_field = add_vector(selected_field, observables.demag_field[index]);
            }
            if plan.external_field.is_some() {
                selected_field = add_vector(selected_field, observables.external_field[index]);
            }
            // Volume anisotropy (uniaxial + cubic) contribution to parallel field
            selected_field = add_vector(selected_field, volume_anisotropy_field(*m, plan));
            dot(*m, selected_field).max(0.0)
        })
        .collect::<Vec<_>>();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        let local_shift = [
            parallel_field[element[0] as usize],
            parallel_field[element[1] as usize],
            parallel_field[element[2] as usize],
            parallel_field[element[3] as usize],
        ];
        for i in 0..4 {
            let node_i = element[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let phase_j = reduction.node_phases[node_j];
                let coeff = phase_i.conj() * phase_j;
                mass[row][col] += coeff * local_mass[i][j];
                if plan.enable_exchange {
                    stiffness[row][col] +=
                        coeff * exchange_coeff * topology.element_stiffness[element_index][i][j];
                }
                let shift = 0.5 * (local_shift[i] + local_shift[j]);
                stiffness[row][col] += coeff * (local_mass[i][j] * shift);
            }
        }
    }

    add_surface_anisotropy_complex(plan, topology, reduction, equilibrium, &mut stiffness);
    add_dmi_complex(plan, reduction, &mut stiffness, plan.k_sampling.as_ref());
    (stiffness, mass)
}

fn assemble_projected_full_2x2_operator_complex(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vec<Complex64>>, Vec<Vec<Complex64>>) {
    let n = reduction.active_nodes.len();
    let dim = 2 * n;
    let mut stiffness = vec![vec![Complex64::new(0.0, 0.0); dim]; dim];
    let mut mass = vec![vec![Complex64::new(0.0, 0.0); dim]; dim];
    let exchange_coeff = exchange_field_coefficient(plan);

    let field_blocks: Vec<[f64; 4]> = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let mut h_eff = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                h_eff = add_vector(h_eff, observables.exchange_field[idx]);
            }
            if plan.enable_demag {
                h_eff = add_vector(h_eff, observables.demag_field[idx]);
            }
            if plan.external_field.is_some() {
                h_eff = add_vector(h_eff, observables.external_field[idx]);
            }
            h_eff = add_vector(h_eff, volume_anisotropy_field(*m, plan));

            let (e1, e2) = bases[idx];
            let h_parallel = dot(*m, h_eff).max(0.0);
            let h_e1 = dot(e1, h_eff);
            let h_e2 = dot(e2, h_eff);
            [
                h_parallel,
                h_e1 * h_e2 / (h_parallel.max(1e-30)),
                h_e1 * h_e2 / (h_parallel.max(1e-30)),
                h_parallel,
            ]
        })
        .collect();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        for i in 0..4 {
            let node_i = element[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            let row_root = reduction.active_nodes[row];
            let row_transport = tangent_transport_to_root(node_i, row_root, bases);
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let coeff = phase_i.conj() * reduction.node_phases[node_j];
                let col_root = reduction.active_nodes[col];
                let col_transport = tangent_transport_to_root(node_j, col_root, bases);
                let m_ij = local_mass[i][j];
                let fb_i = &field_blocks[node_i];
                let fb_j = &field_blocks[node_j];

                add_complex_tangent_block(
                    &mut mass,
                    n,
                    row,
                    col,
                    project_local_tangent_block_to_reduced(
                        coeff,
                        row_transport,
                        [[m_ij, 0.0], [0.0, m_ij]],
                        col_transport,
                    ),
                );

                if plan.enable_exchange {
                    let ex = exchange_coeff * topology.element_stiffness[element_index][i][j];
                    add_complex_tangent_block(
                        &mut stiffness,
                        n,
                        row,
                        col,
                        project_local_tangent_block_to_reduced(
                            coeff,
                            row_transport,
                            [[ex, 0.0], [0.0, ex]],
                            col_transport,
                        ),
                    );
                }

                let h11 = 0.5 * (fb_i[0] + fb_j[0]);
                let h12 = 0.5 * (fb_i[1] + fb_j[1]);
                let h21 = 0.5 * (fb_i[2] + fb_j[2]);
                let h22 = 0.5 * (fb_i[3] + fb_j[3]);
                add_complex_tangent_block(
                    &mut stiffness,
                    n,
                    row,
                    col,
                    project_local_tangent_block_to_reduced(
                        coeff,
                        row_transport,
                        [[m_ij * h11, m_ij * h12], [m_ij * h21, m_ij * h22]],
                        col_transport,
                    ),
                );
            }
        }
    }

    add_surface_anisotropy_2x2_complex(plan, topology, reduction, equilibrium, &mut stiffness, n);
    add_dmi_2x2_complex(plan, reduction, &mut stiffness, plan.k_sampling.as_ref(), n);
    (stiffness, mass)
}

fn regularize_periodic_mass_if_needed(
    mut mass: DMatrix<f64>,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
) -> DMatrix<f64> {
    if !matches!(
        spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return mass;
    }
    if mass.nrows() == 0 {
        return mass;
    }
    for row in 0..mass.nrows() {
        for col in (row + 1)..mass.ncols() {
            let sym = 0.5 * (mass[(row, col)] + mass[(col, row)]);
            mass[(row, col)] = sym;
            mass[(col, row)] = sym;
        }
    }
    if mass.clone().cholesky().is_some() {
        return mass;
    }
    let mut scale = 0.0_f64;
    for row in 0..mass.nrows() {
        for col in 0..mass.ncols() {
            scale = scale.max(mass[(row, col)].abs());
        }
    }
    let scale = scale.max(1.0);
    for factor in [1e-12_f64, 1e-10, 1e-8, 1e-6] {
        let epsilon = scale * factor;
        let mut trial = mass.clone();
        for index in 0..trial.nrows() {
            trial[(index, index)] += epsilon;
        }
        if trial.clone().cholesky().is_some() {
            return trial;
        }
    }
    mass
}

fn solve_real_symmetric_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
    let cholesky = mass.clone().cholesky().ok_or_else(|| RunError {
        message: "FEM eigen mass matrix is singular; ensure the magnetic mesh has active volume"
            .to_string(),
    })?;
    let l = cholesky.l();
    let l_inv = l.clone().try_inverse().ok_or_else(|| RunError {
        message: "failed to invert FEM eigen mass Cholesky factor".to_string(),
    })?;
    let transformed = &l_inv * stiffness * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let mut eigenpairs = spectrum
        .eigenvalues
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            if !value.is_finite() {
                return None;
            }
            let lifted = l_inv.transpose() * spectrum.eigenvectors.column(index).into_owned();
            let normalized = normalize_real_mode(lifted, &mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, &mass, *value, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: *value,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(&mass, &normalized),
                vector: normalized,
            })
        })
        .collect::<Vec<_>>();
    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

/// Sparse LOBPCG eigensolver for large problems.
///
/// Converts dense-assembled stiffness and mass matrices to CSR format
/// and uses LOBPCG to find the k smallest eigenpairs in O(k·n·iter) time
/// instead of the O(n³) dense path.
fn solve_real_symmetric_eigenpairs_sparse(
    plan: &FemEigenPlanIR,
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    num_modes: usize,
    progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
    let n = stiffness.nrows();

    // Convert to CSR (drop entries < 1e-15 to preserve sparsity)
    let k_csr = dmatrix_to_csr(&stiffness, 1e-15);
    let m_csr = dmatrix_to_csr(&mass, 1e-15);

    // LOBPCG: find num_modes smallest eigenpairs
    let tol = 1e-8;
    let max_iter = (n * 2).max(500).min(5000) as u32;
    let solver_modes = sparse_lobpcg_candidate_count(&plan.target, num_modes, n);
    if solver_modes > num_modes {
        eprintln!(
            "warning: FEM eigen frequency_window uses oversampled lowest-mode sparse LOBPCG candidates \
             (requested={}, candidates={}); production interior-window eigensolve requires shift-invert/FEAST/SLEPc",
            num_modes, solver_modes
        );
    }
    let mut interrupted: Option<RunError> = None;
    let mut progress = progress;
    let mut progress_callback = |lobpcg: fullmag_engine::fem_sparse::LobpcgProgress| {
        if interrupted.is_some() {
            return;
        }
        let iter_fraction = if lobpcg.max_iterations > 0 {
            f64::from(lobpcg.iteration) / f64::from(lobpcg.max_iterations)
        } else {
            0.0
        };
        let convergence_fraction = if lobpcg.requested_count > 0 {
            lobpcg.converged_count as f64 / lobpcg.requested_count as f64
        } else {
            0.0
        };
        let percent = 35.0 + 45.0 * iter_fraction.max(convergence_fraction).min(1.0);
        let result = emit_fem_eigen_progress(
            &mut progress,
            FemEigenProgress {
                phase: "solving_sparse_lobpcg",
                phase_index: 3,
                phase_count: 5,
                percent,
                solver_kind: "cpu_sparse_lobpcg",
                active_nodes,
                effective_dof,
                requested_modes: num_modes,
                candidate_modes: solver_modes,
                computed_modes: lobpcg.converged_count.min(num_modes),
                iteration: Some(lobpcg.iteration),
                max_iterations: Some(lobpcg.max_iterations),
                residual: Some(lobpcg.max_residual),
                warning: sparse_lobpcg_progress_warning(plan, solver_modes, num_modes),
            },
        );
        if let Err(error) = result {
            interrupted = Some(error);
        }
    };
    let (sparse_pairs, report) = lobpcg_generalized_with_progress(
        &k_csr,
        &m_csr,
        solver_modes,
        tol,
        max_iter,
        Some(&mut progress_callback),
    )
    .map_err(|e| RunError {
        message: format!("sparse LOBPCG eigensolver failed: {}", e.message),
    })?;
    if let Some(error) = interrupted {
        return Err(error);
    }

    eprintln!(
        "info: sparse LOBPCG converged={} in {} iterations (max_residual={:.2e}, {} candidates)",
        report.converged,
        report.iterations,
        report.max_residual,
        sparse_pairs.len()
    );

    // Convert SparseEigenpair to RealEigenpair
    let finite_candidate_count = sparse_pairs
        .iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .count();
    let mut eigenpairs: Vec<RealEigenpair> = sparse_pairs
        .into_iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .map(|ep| {
            let vec = DVector::from_vec(ep.vector);
            let normalized = normalize_real_mode(vec, &mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, &mass, ep.eigenvalue, &normalized);
            RealEigenpair {
                eigenvalue_real: ep.eigenvalue,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(&mass, &normalized),
                vector: normalized,
            }
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    reject_empty_frequency_window_result(
        &plan.target,
        solver_modes,
        finite_candidate_count,
        eigenpairs.len(),
    )?;
    Ok(eigenpairs)
}

fn sparse_lobpcg_candidate_count(
    target: &fullmag_ir::EigenTargetIR,
    requested_count: usize,
    matrix_size: usize,
) -> usize {
    if requested_count == 0 || matrix_size == 0 {
        return 0;
    }
    let requested_count = requested_count.min(matrix_size);
    if !matches!(target, fullmag_ir::EigenTargetIR::FrequencyWindow { .. }) {
        return requested_count;
    }
    let window_position_multiplier = match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } if *frequency_min_hz > 0.0 && *frequency_max_hz > *frequency_min_hz => {
            let relative_width =
                ((*frequency_max_hz - *frequency_min_hz) / *frequency_min_hz).clamp(0.05, 10.0);
            let lower_edge_multiplier = ((*frequency_max_hz / *frequency_min_hz).sqrt()).ceil();
            let width_multiplier = (1.0 / relative_width).sqrt().ceil();
            (lower_edge_multiplier + width_multiplier).max(2.0) as usize
        }
        _ => 2,
    };
    let min_extra = requested_count.max(8);
    requested_count
        .saturating_mul(window_position_multiplier)
        .max(requested_count + min_extra)
        .min(matrix_size)
        .max(requested_count)
}

fn reject_empty_frequency_window_result(
    target: &fullmag_ir::EigenTargetIR,
    solver_modes: usize,
    candidate_count: usize,
    retained_count: usize,
) -> Result<(), RunError> {
    if retained_count > 0 || !matches!(target, fullmag_ir::EigenTargetIR::FrequencyWindow { .. }) {
        return Ok(());
    }
    Err(RunError {
        message: format!(
            "FEM eigen frequency_window returned no modes in the requested interval after {} \
             sparse LOBPCG candidates ({} finite candidates). The current reference solver \
             oversamples lowest modes and cannot guarantee interior-window coverage; use a lower \
             window, reduce the mesh for dense validation, or wait for the production shift-invert/FEAST/SLEPc backend.",
            solver_modes, candidate_count
        ),
    })
}

fn sparse_lobpcg_progress_warning(
    plan: &FemEigenPlanIR,
    solver_modes: usize,
    requested_modes: usize,
) -> Option<&'static str> {
    if solver_modes > requested_modes
        && matches!(
            plan.target,
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
        )
    {
        Some("frequency_window_sparse_lobpcg_uses_oversampled_lowest_candidates")
    } else {
        None
    }
}

fn solve_complex_hermitian_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: Vec<Vec<Complex64>>,
    mass: Vec<Vec<Complex64>>,
) -> Result<Vec<ComplexEigenpair>, RunError> {
    let (stiffness_block, mass_block) = complex_pair_to_real_blocks(&stiffness, &mass);
    let mass_block = regularize_periodic_mass_if_needed(mass_block, &plan.spin_wave_bc);
    let cholesky = mass_block.clone().cholesky().ok_or_else(|| RunError {
        message: "Floquet FEM eigen mass block is singular; check periodic node-pair metadata"
            .to_string(),
    })?;
    let l = cholesky.l();
    let l_inv = l.clone().try_inverse().ok_or_else(|| RunError {
        message: "failed to invert Floquet FEM eigen mass block Cholesky factor".to_string(),
    })?;
    let transformed = &l_inv * &stiffness_block * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let active_count = stiffness.len();
    let mut eigenpairs = Vec::new();
    for (index, value) in spectrum.eigenvalues.iter().enumerate() {
        if !value.is_finite() {
            continue;
        }
        let lifted = l_inv.transpose() * spectrum.eigenvectors.column(index).into_owned();
        let complex = real_block_vector_to_complex(&lifted, active_count);
        let normalized = normalize_complex_mode(&complex, &mass, &plan.normalization);
        let normalized_block = complex_vector_to_real_block(&normalized);
        let (residual_absolute_l2, residual_relative_l2, residual_linf) =
            generalized_residual_norms(&stiffness_block, &mass_block, *value, &normalized_block);
        eigenpairs.push(ComplexEigenpair {
            eigenvalue_real: *value,
            eigenvalue_imag: 0.0,
            residual_absolute_l2,
            residual_relative_l2,
            residual_linf,
            mass_norm: generalized_mass_norm(&mass_block, &normalized_block),
            vector: normalized,
        });
    }
    sort_and_truncate_complex_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

fn generalized_residual_norms(
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    eigenvalue: f64,
    vector: &DVector<f64>,
) -> (f64, f64, f64) {
    if stiffness.ncols() != vector.len() || mass.ncols() != vector.len() {
        return (f64::NAN, f64::NAN, f64::NAN);
    }
    let residual = stiffness * vector - mass * vector * eigenvalue;
    let residual_absolute_l2 = residual.norm();
    let ku_norm = (stiffness * vector).norm();
    let mu_norm = (mass * vector).norm();
    let denominator = ku_norm + eigenvalue.abs() * mu_norm;
    let residual_relative_l2 = if denominator > 0.0 {
        residual_absolute_l2 / denominator
    } else {
        0.0
    };
    let residual_linf = residual
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    (residual_absolute_l2, residual_relative_l2, residual_linf)
}

fn generalized_mass_norm(mass: &DMatrix<f64>, vector: &DVector<f64>) -> f64 {
    if mass.ncols() != vector.len() {
        return f64::NAN;
    }
    vector.dot(&(mass * vector))
}

fn orthogonality_rows_json(
    mass: &DMatrix<f64>,
    eigenpairs: &[RealEigenpair],
) -> Vec<serde_json::Value> {
    eigenpairs
        .iter()
        .enumerate()
        .flat_map(|(lhs_index, lhs)| {
            eigenpairs.iter().enumerate().map(move |(rhs_index, rhs)| {
                serde_json::json!({
                    "lhs_mode_index": lhs_index,
                    "rhs_mode_index": rhs_index,
                    "mass_inner_product": lhs.vector.dot(&(mass * &rhs.vector)),
                })
            })
        })
        .collect()
}

fn complex_vector_to_real_block(vector: &[Complex64]) -> DVector<f64> {
    let mut block = DVector::<f64>::zeros(vector.len() * 2);
    for (index, value) in vector.iter().enumerate() {
        block[index] = value.re;
        block[index + vector.len()] = value.im;
    }
    block
}

fn mode_tangent_leakage(
    equilibrium: &[[f64; 3]],
    real: &[[f64; 3]],
    imag: &[[f64; 3]],
) -> (f64, f64) {
    let real_summary = tangent_leakage_summary(equilibrium, real);
    let imag_summary = tangent_leakage_summary(equilibrium, imag);
    if real.is_empty() && imag.is_empty() {
        return (0.0, 0.0);
    }
    let sample_count = real.len() + imag.len();
    (
        (real_summary.mean_abs * real.len() as f64 + imag_summary.mean_abs * imag.len() as f64)
            / sample_count as f64,
        real_summary.max_abs.max(imag_summary.max_abs),
    )
}

fn tangent_leakage_summary(
    equilibrium: &[[f64; 3]],
    mode_vectors: &[[f64; 3]],
) -> TangentLeakageSummary {
    let mut count = 0usize;
    let mut total = 0.0_f64;
    let mut max = 0.0_f64;
    for (m0, delta_m) in equilibrium.iter().zip(mode_vectors.iter()) {
        let leakage = (m0[0] * delta_m[0] + m0[1] * delta_m[1] + m0[2] * delta_m[2]).abs();
        total += leakage;
        max = max.max(leakage);
        count += 1;
    }
    if count == 0 {
        TangentLeakageSummary {
            mean_abs: 0.0,
            max_abs: 0.0,
        }
    } else {
        TangentLeakageSummary {
            mean_abs: total / count as f64,
            max_abs: max,
        }
    }
}

fn complex_pair_to_real_blocks(
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
) -> (DMatrix<f64>, DMatrix<f64>) {
    let n = stiffness.len();
    let mut a = DMatrix::<f64>::zeros(2 * n, 2 * n);
    let mut b = DMatrix::<f64>::zeros(2 * n, 2 * n);
    for row in 0..n {
        for col in 0..n {
            let k = stiffness[row][col];
            let m = mass[row][col];
            a[(row, col)] = k.re;
            a[(row, col + n)] = -k.im;
            a[(row + n, col)] = k.im;
            a[(row + n, col + n)] = k.re;

            b[(row, col)] = m.re;
            b[(row, col + n)] = -m.im;
            b[(row + n, col)] = m.im;
            b[(row + n, col + n)] = m.re;
        }
    }
    (a, b)
}

fn native_bloch_floquet_dense_payload_from_complex_pair(
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
) -> Result<NativeBlochFloquetDensePayload, RunError> {
    if stiffness.is_empty() || stiffness.len() != mass.len() {
        return Err(RunError {
            message: "native Bloch/Floquet payload requires non-empty matching stiffness and mass matrices"
                .to_string(),
        });
    }
    let physical_complex_dof = stiffness.len();
    if stiffness
        .iter()
        .any(|row| row.len() != physical_complex_dof)
        || mass.iter().any(|row| row.len() != physical_complex_dof)
    {
        return Err(RunError {
            message:
                "native Bloch/Floquet payload requires square complex stiffness and mass matrices"
                    .to_string(),
        });
    }

    let (stiffness_block, mass_block) = complex_pair_to_real_blocks(stiffness, mass);
    let block_dof = stiffness_block.nrows();
    let embedded_dof = block_dof.checked_mul(2).ok_or_else(|| RunError {
        message: "native Bloch/Floquet embedded payload dimension overflow".to_string(),
    })?;
    let mut stiffness_embedded = DMatrix::<f64>::zeros(embedded_dof, embedded_dof);
    let mut tangent_mass = DMatrix::<f64>::zeros(embedded_dof, embedded_dof);
    for row in 0..block_dof {
        for col in 0..block_dof {
            stiffness_embedded[(row, col)] = stiffness_block[(row, col)];
            stiffness_embedded[(row + block_dof, col + block_dof)] = stiffness_block[(row, col)];
            tangent_mass[(row, col)] = mass_block[(row, col)];
            tangent_mass[(row + block_dof, col + block_dof)] = mass_block[(row, col)];
        }
    }
    let mut gyrotropic_row_major = vec![0.0; embedded_dof * embedded_dof];
    for row in 0..block_dof {
        for col in 0..block_dof {
            let value = mass_block[(row, col)];
            gyrotropic_row_major[row * embedded_dof + col + block_dof] = -value;
            gyrotropic_row_major[(row + block_dof) * embedded_dof + col] = value;
        }
    }

    Ok(NativeBlochFloquetDensePayload {
        physical_complex_dof,
        stiffness: stiffness_embedded,
        gyrotropic_row_major,
        tangent_mass,
        physical_mass: mass.to_vec(),
    })
}

fn deembed_native_bloch_floquet_mode_vector(
    embedded: &[Complex64],
    physical_complex_dof: usize,
) -> Result<Vec<Complex64>, RunError> {
    let real_block_dof = physical_complex_dof
        .checked_mul(2)
        .ok_or_else(|| RunError {
            message: "native Bloch/Floquet de-embedding dimension overflow".to_string(),
        })?;
    let expected = real_block_dof.checked_mul(2).ok_or_else(|| RunError {
        message: "native Bloch/Floquet embedded mode dimension overflow".to_string(),
    })?;
    if physical_complex_dof == 0 || embedded.len() != expected {
        return Err(RunError {
            message: format!(
                "native Bloch/Floquet embedded mode has length {}, expected {} for {} physical complex DOF",
                embedded.len(),
                expected,
                physical_complex_dof
            ),
        });
    }

    let mut real_block = Vec::with_capacity(real_block_dof);
    for index in 0..real_block_dof {
        real_block
            .push((embedded[index] - Complex64::i() * embedded[index + real_block_dof]) * 0.5);
    }
    Ok((0..physical_complex_dof)
        .map(|index| real_block[index] + Complex64::i() * real_block[index + physical_complex_dof])
        .collect())
}

fn real_block_vector_to_complex(vector: &DVector<f64>, active_count: usize) -> Vec<Complex64> {
    (0..active_count)
        .map(|index| Complex64::new(vector[index], vector[index + active_count]))
        .collect()
}

fn normalize_real_mode(
    vector: DVector<f64>,
    mass: &DMatrix<f64>,
    normalization: &EigenNormalizationIR,
) -> DVector<f64> {
    match normalization {
        EigenNormalizationIR::UnitL2 => {
            let projected = mass * &vector;
            let norm = vector.dot(&projected).sqrt().max(1e-30);
            vector / norm
        }
        EigenNormalizationIR::UnitMaxAmplitude => {
            let max_value = vector
                .iter()
                .fold(0.0_f64, |acc, value| acc.max(value.abs()))
                .max(1e-30);
            vector / max_value
        }
    }
}

fn normalize_complex_mode(
    vector: &[Complex64],
    mass: &[Vec<Complex64>],
    normalization: &EigenNormalizationIR,
) -> Vec<Complex64> {
    match normalization {
        EigenNormalizationIR::UnitL2 => {
            let mut quadratic = Complex64::new(0.0, 0.0);
            for row in 0..vector.len() {
                for col in 0..vector.len() {
                    quadratic += vector[row].conj() * mass[row][col] * vector[col];
                }
            }
            let scale = quadratic.re.max(1e-30).sqrt();
            vector.iter().map(|value| *value / scale).collect()
        }
        EigenNormalizationIR::UnitMaxAmplitude => {
            let scale = vector
                .iter()
                .fold(0.0_f64, |acc, value| acc.max(value.norm()))
                .max(1e-30);
            vector.iter().map(|value| *value / scale).collect()
        }
    }
}

fn complex_mass_norm(mass: &[Vec<Complex64>], vector: &[Complex64]) -> Complex64 {
    let mut norm = Complex64::new(0.0, 0.0);
    for row in 0..vector.len() {
        let mut projected = Complex64::new(0.0, 0.0);
        for col in 0..vector.len() {
            projected += mass[row][col] * vector[col];
        }
        norm += vector[row].conj() * projected;
    }
    norm
}

fn sort_and_truncate_real_modes(plan: &FemEigenPlanIR, eigenpairs: &mut Vec<RealEigenpair>) {
    match &plan.target {
        fullmag_ir::EigenTargetIR::Lowest => eigenpairs.sort_by(|lhs, rhs| {
            lhs.eigenvalue_real
                .partial_cmp(&rhs.eigenvalue_real)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => eigenpairs.sort_by(|lhs, rhs| {
            let lhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
            let rhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
            (lhs_freq - *frequency_hz)
                .abs()
                .partial_cmp(&(rhs_freq - *frequency_hz).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => {
            eigenpairs.retain(|pair| {
                let frequency =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, pair.eigenvalue_real);
                frequency >= *frequency_min_hz && frequency <= *frequency_max_hz
            });
            eigenpairs.sort_by(|lhs, rhs| {
                let lhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
                let rhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
                lhs_freq
                    .partial_cmp(&rhs_freq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }
    let requested_count = usize::try_from(plan.count).unwrap_or(usize::MAX);
    eigenpairs.truncate(requested_count.min(eigenpairs.len()));
}

fn sort_and_truncate_complex_modes(plan: &FemEigenPlanIR, eigenpairs: &mut Vec<ComplexEigenpair>) {
    match &plan.target {
        fullmag_ir::EigenTargetIR::Lowest => eigenpairs.sort_by(|lhs, rhs| {
            lhs.eigenvalue_real
                .partial_cmp(&rhs.eigenvalue_real)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => eigenpairs.sort_by(|lhs, rhs| {
            let lhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
            let rhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
            (lhs_freq - *frequency_hz)
                .abs()
                .partial_cmp(&(rhs_freq - *frequency_hz).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => {
            eigenpairs.retain(|pair| {
                let frequency =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, pair.eigenvalue_real);
                frequency >= *frequency_min_hz && frequency <= *frequency_max_hz
            });
            eigenpairs.sort_by(|lhs, rhs| {
                let lhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
                let rhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
                lhs_freq
                    .partial_cmp(&rhs_freq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }
    let requested_count = usize::try_from(plan.count).unwrap_or(usize::MAX);
    eigenpairs.truncate(requested_count.min(eigenpairs.len()));
}

fn add_surface_anisotropy_real(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut DMatrix<f64>,
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    let boundary_faces = plan
        .mesh
        .require_tri3_boundary_faces()
        .expect("surface anisotropy requires tri3 facets; planner must reject mixed facets");
    for face in &boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let Some(row) = reduction.node_map[face[i] as usize] else {
                continue;
            };
            for j in 0..3 {
                let Some(col) = reduction.node_map[face[j] as usize] else {
                    continue;
                };
                stiffness[(row, col)] += local[i][j];
            }
        }
    }
}

fn add_surface_anisotropy_complex(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut [Vec<Complex64>],
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    let boundary_faces = plan
        .mesh
        .require_tri3_boundary_faces()
        .expect("surface anisotropy requires tri3 facets; planner must reject mixed facets");
    for face in &boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let node_i = face[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            for j in 0..3 {
                let node_j = face[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let phase_j = reduction.node_phases[node_j];
                stiffness[row][col] += phase_i.conj() * phase_j * local[i][j];
            }
        }
    }
}

fn add_dmi_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    stiffness: &mut DMatrix<f64>,
) {
    let scale = plan.interfacial_dmi.map(f64::abs).unwrap_or(0.0)
        + plan.bulk_dmi.map(f64::abs).unwrap_or(0.0);
    if scale <= 0.0 {
        return;
    }
    let coeff =
        scale / (MU0 * plan.material.saturation_magnetisation.max(1e-30) * plan.hmax.max(1e-30));
    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let gradients = &topology.grad_phi[element_index];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                let skew = coeff
                    * (gradients[i][0] * gradients[j][1] - gradients[i][1] * gradients[j][0])
                    * topology.element_volumes[element_index];
                stiffness[(row, col)] += skew;
            }
        }
    }
}

fn add_dmi_complex(
    plan: &FemEigenPlanIR,
    reduction: &ReductionMap,
    stiffness: &mut [Vec<Complex64>],
    k_sampling: Option<&KSamplingIR>,
) {
    let interfacial = plan.interfacial_dmi.unwrap_or(0.0);
    let bulk = plan.bulk_dmi.unwrap_or(0.0);
    if interfacial == 0.0 && bulk == 0.0 {
        return;
    }
    let k = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let ms = plan.material.saturation_magnetisation.max(1e-30);
    let interfacial_coeff = interfacial / (MU0 * ms);
    let bulk_coeff = bulk / (MU0 * ms);
    let nonreciprocal_shift = interfacial_coeff * (k[0] + k[1]) + bulk_coeff * (k[0] + k[1] + k[2]);
    if nonreciprocal_shift.abs() <= 0.0 {
        return;
    }
    for index in 0..reduction.active_nodes.len() {
        stiffness[index][index] += Complex64::new(nonreciprocal_shift, 0.0);
    }
}

fn add_surface_anisotropy_2x2_complex(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut [Vec<Complex64>],
    n: usize,
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    let boundary_faces = plan
        .mesh
        .require_tri3_boundary_faces()
        .expect("surface anisotropy requires tri3 facets; planner must reject mixed facets");
    for face in &boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let node_i = face[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            for j in 0..3 {
                let node_j = face[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let coeff = phase_i.conj() * reduction.node_phases[node_j] * local[i][j];
                stiffness[row][col] += coeff;
                stiffness[row + n][col + n] += coeff;
            }
        }
    }
}

fn add_dmi_2x2_complex(
    plan: &FemEigenPlanIR,
    reduction: &ReductionMap,
    stiffness: &mut [Vec<Complex64>],
    k_sampling: Option<&KSamplingIR>,
    n: usize,
) {
    let interfacial = plan.interfacial_dmi.unwrap_or(0.0);
    let bulk = plan.bulk_dmi.unwrap_or(0.0);
    if interfacial == 0.0 && bulk == 0.0 {
        return;
    }
    let k = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let ms = plan.material.saturation_magnetisation.max(1e-30);
    let interfacial_coeff = interfacial / (MU0 * ms);
    let bulk_coeff = bulk / (MU0 * ms);
    let nonreciprocal_shift = interfacial_coeff * (k[0] + k[1]) + bulk_coeff * (k[0] + k[1] + k[2]);
    if nonreciprocal_shift.abs() <= 0.0 {
        return;
    }
    for index in 0..reduction.active_nodes.len() {
        stiffness[index][index] += Complex64::new(nonreciprocal_shift, 0.0);
        stiffness[index + n][index + n] += Complex64::new(nonreciprocal_shift, 0.0);
    }
}

/// Apply surface anisotropy to the 2×2 block operator.
/// Both diagonal blocks (K_11, K_22) get the same surface anisotropy term.
fn add_surface_anisotropy_2x2(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut DMatrix<f64>,
    n: usize,
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    let boundary_faces = plan
        .mesh
        .require_tri3_boundary_faces()
        .expect("surface anisotropy requires tri3 facets; planner must reject mixed facets");
    for face in &boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let Some(row) = reduction.node_map[face[i] as usize] else {
                continue;
            };
            for j in 0..3 {
                let Some(col) = reduction.node_map[face[j] as usize] else {
                    continue;
                };
                // Both diagonal blocks
                stiffness[(row, col)] += local[i][j];
                stiffness[(row + n, col + n)] += local[i][j];
            }
        }
    }
}

/// Apply DMI to the 2×2 block operator.
/// Both diagonal blocks get the same DMI skew contribution.
fn add_dmi_2x2(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    stiffness: &mut DMatrix<f64>,
    n: usize,
) {
    let scale = plan.interfacial_dmi.map(f64::abs).unwrap_or(0.0)
        + plan.bulk_dmi.map(f64::abs).unwrap_or(0.0);
    if scale <= 0.0 {
        return;
    }
    let coeff =
        scale / (MU0 * plan.material.saturation_magnetisation.max(1e-30) * plan.hmax.max(1e-30));
    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let gradients = &topology.grad_phi[element_index];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                let skew = coeff
                    * (gradients[i][0] * gradients[j][1] - gradients[i][1] * gradients[j][0])
                    * topology.element_volumes[element_index];
                // Both diagonal blocks
                stiffness[(row, col)] += skew;
                stiffness[(row + n, col + n)] += skew;
            }
        }
    }
}

fn exchange_field_coefficient(plan: &FemEigenPlanIR) -> f64 {
    2.0 * plan.material.exchange_stiffness
        / (MU0 * plan.material.saturation_magnetisation.max(1e-30))
}

/// Compute the uniaxial anisotropy effective field at a single node.
///
/// H_uni = (2 Ku1 / (mu0 Ms)) (m · u) u + (4 Ku2 / (mu0 Ms)) (m · u)^3 u
fn uniaxial_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    let ku1 = match plan.material.uniaxial_anisotropy {
        Some(k) if k.abs() > 0.0 => k,
        _ => return [0.0, 0.0, 0.0],
    };
    let axis = normalize_vector(plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]));
    let ms = plan.material.saturation_magnetisation.max(1e-30);
    let ku2 = plan.material.uniaxial_anisotropy_k2.unwrap_or(0.0);
    let m_dot_u = dot(m, axis);
    let coeff =
        2.0 * ku1 / (MU0 * ms) * m_dot_u + 4.0 * ku2 / (MU0 * ms) * m_dot_u * m_dot_u * m_dot_u;
    scale_vector(axis, coeff)
}

/// Compute the cubic anisotropy effective field at a single node.
///
/// First-order cubic: H_c1 = -(2 Kc1 / (mu0 Ms)) ∂E/∂m  with the standard
/// cubic energy density  E = Kc1 (m1² m2² + m2² m3² + m1² m3²) + ...
fn cubic_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    let kc1 = match plan.material.cubic_anisotropy_kc1 {
        Some(k) if k.abs() > 0.0 => k,
        _ => return [0.0, 0.0, 0.0],
    };
    let c1 = normalize_vector(
        plan.material
            .cubic_anisotropy_axis1
            .unwrap_or([1.0, 0.0, 0.0]),
    );
    let c2 = normalize_vector(
        plan.material
            .cubic_anisotropy_axis2
            .unwrap_or([0.0, 1.0, 0.0]),
    );
    let c3 = cross(c1, c2);
    let kc2 = plan.material.cubic_anisotropy_kc2.unwrap_or(0.0);
    let ms = plan.material.saturation_magnetisation.max(1e-30);

    let m1 = dot(m, c1);
    let m2 = dot(m, c2);
    let m3 = dot(m, c3);

    let pf = 2.0 / (MU0 * ms);

    // dE/dm_i for cubic energy E = Kc1 (m1² m2² + m2² m3² + m1² m3²)
    //                             + Kc2 (m1² m2² m3²)
    let g1 = -pf * (kc1 * m1 * (m2 * m2 + m3 * m3) + kc2 * m1 * m2 * m2 * m3 * m3);
    let g2 = -pf * (kc1 * m2 * (m1 * m1 + m3 * m3) + kc2 * m2 * m1 * m1 * m3 * m3);
    let g3 = -pf * (kc1 * m3 * (m1 * m1 + m2 * m2) + kc2 * m3 * m1 * m1 * m2 * m2);

    [
        g1 * c1[0] + g2 * c2[0] + g3 * c3[0],
        g1 * c1[1] + g2 * c2[1] + g3 * c3[1],
        g1 * c1[2] + g2 * c2[2] + g3 * c3[2],
    ]
}

/// Compute the total volume anisotropy field (uniaxial + cubic) at a node.
fn volume_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    add_vector(
        uniaxial_anisotropy_field(m, plan),
        cubic_anisotropy_field(m, plan),
    )
}

fn surface_anisotropy_config(plan: &FemEigenPlanIR) -> Option<(Vector3, f64)> {
    let ks = plan.spin_wave_bc.surface_anisotropy_ks()?;
    let axis = normalize_vector(plan.spin_wave_bc.surface_anisotropy_axis()?);
    let coefficient = ks / (MU0 * plan.material.saturation_magnetisation.max(1e-30));
    Some((axis, coefficient))
}

fn triangle_surface_matrix(
    face: &[u32; 3],
    nodes: &[[f64; 3]],
    axis: Vector3,
    equilibrium: &[Vector3],
    coefficient: f64,
) -> [[f64; 3]; 3] {
    let p0 = nodes[face[0] as usize];
    let p1 = nodes[face[1] as usize];
    let p2 = nodes[face[2] as usize];
    let area = 0.5 * norm(cross(sub(p1, p0), sub(p2, p0)));
    let local_mass = [
        [2.0 * area / 12.0, area / 12.0, area / 12.0],
        [area / 12.0, 2.0 * area / 12.0, area / 12.0],
        [area / 12.0, area / 12.0, 2.0 * area / 12.0],
    ];
    let alignment = face
        .iter()
        .map(|node| {
            let m = equilibrium[*node as usize];
            1.0 - dot(m, axis).powi(2)
        })
        .sum::<f64>()
        / 3.0;
    let mut local = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            local[i][j] = coefficient * alignment.max(0.0) * local_mass[i][j];
        }
    }
    local
}

fn tangent_bases(equilibrium: &[Vector3]) -> Vec<(Vector3, Vector3)> {
    equilibrium
        .iter()
        .map(|m| {
            let reference = if m[2].abs() < 0.9 {
                [0.0, 0.0, 1.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            let e1 = normalize_vector(cross(reference, *m));
            let e2 = normalize_vector(cross(*m, e1));
            (e1, e2)
        })
        .collect()
}

fn project_real_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &DVector<f64>,
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let a = amplitudes[reduced_index];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = scale_vector(e1, a);
        imag[*node_index] = scale_vector(e2, a);
        amplitude[*node_index] = a.abs();
        phase[*node_index] = if a >= 0.0 { 0.0 } else { std::f64::consts::PI };
        max_amplitude = max_amplitude.max(a.abs());
    }

    (real, imag, amplitude, phase, max_amplitude)
}

fn project_complex_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &[Complex64],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let value = amplitudes[reduced_index];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = scale_vector(e1, value.re);
        imag[*node_index] = scale_vector(e2, value.im);
        amplitude[*node_index] = value.norm();
        phase[*node_index] = value.arg();
        max_amplitude = max_amplitude.max(amplitude[*node_index]);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

fn project_complex_2x2_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &[Complex64],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let n = active_nodes.len();
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    if amplitudes.len() < 2 * n {
        return (real, imag, amplitude, phase, max_amplitude);
    }

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let u1 = amplitudes[reduced_index];
        let u2 = amplitudes[reduced_index + n];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = add_vector(scale_vector(e1, u1.re), scale_vector(e2, u2.re));
        imag[*node_index] = add_vector(scale_vector(e1, u1.im), scale_vector(e2, u2.im));
        let amp = (u1.norm_sqr() + u2.norm_sqr()).sqrt();
        amplitude[*node_index] = amp;
        phase[*node_index] = (u1.im + u2.im).atan2(u1.re + u2.re);
        max_amplitude = max_amplitude.max(amp);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

/// Project a 2×2 block eigenvector back to full 3D mode fields.
///
/// The eigenvector has 2N elements: [u1_0..u1_{N-1}, u2_0..u2_{N-1}]
/// where u1 are the e1-component amplitudes and u2 are the e2-component
/// amplitudes.  The 3D mode field is dm = u1*e1 + u2*e2.
fn project_2x2_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &DVector<f64>,
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let n = active_nodes.len();
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let u1 = amplitudes[reduced_index]; // e1 component
        let u2 = amplitudes[reduced_index + n]; // e2 component
        let (e1, e2) = bases[*node_index];

        // Real part of the mode: dm_real = u1*e1 + u2*e2
        real[*node_index] = add_vector(scale_vector(e1, u1), scale_vector(e2, u2));
        // Imaginary part: for the undamped real-symmetric case, the mode
        // oscillates as dm ~ cos(ωt)*u, so the "imaginary" part is the
        // orthogonal tangent component (circular/elliptical precession).
        imag[*node_index] = add_vector(scale_vector(e1, -u2), scale_vector(e2, u1));
        let amp = (u1 * u1 + u2 * u2).sqrt();
        amplitude[*node_index] = amp;
        phase[*node_index] = u2.atan2(u1);
        max_amplitude = max_amplitude.max(amp);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

fn frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    angular_frequency_from_eigenvalue(gyromagnetic_ratio, eigenvalue) / (2.0 * std::f64::consts::PI)
}

fn angular_frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    // gyromagnetic_ratio is μ₀γ (≈ 2.211e5 m/(A·s)), eigenvalue is H_eff in A/m.
    // ω = μ₀γ · H_eff — no additional μ₀ factor needed.
    gyromagnetic_ratio * eigenvalue.max(0.0)
}

fn angular_frequency_from_raw_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    gyromagnetic_ratio * eigenvalue
}

fn requested_mode_indices(outputs: &[OutputIR]) -> std::collections::BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| {
            if let OutputIR::EigenMode { indices, .. } = output {
                Some(indices.iter().copied())
            } else {
                None
            }
        })
        .flatten()
        .collect()
}

fn json_artifact(
    path: impl Into<String>,
    value: &serde_json::Value,
) -> Result<AuxiliaryArtifact, RunError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| RunError {
        message: format!("failed to serialize eigen artifact: {}", error),
    })?;
    Ok(AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    })
}

fn binary_artifact(path: impl Into<String>, bytes: Vec<u8>) -> AuxiliaryArtifact {
    AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    }
}

fn published_artifact_sha256(
    artifacts: &[AuxiliaryArtifact],
    relative_path: &str,
) -> Result<String, RunError> {
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == relative_path)
        .ok_or_else(|| RunError {
            message: format!(
                "missing published artifact required for content digest: {relative_path}"
            ),
        })?;
    Ok(format!("sha256:{:x}", Sha256::digest(&artifact.bytes)))
}

fn mode_field_id(sample_index: usize, raw_mode_index: u64) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

fn mode_field_resource_key(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
        mode_field_id(sample_index, raw_mode_index)
    )
}

fn mode_meta_resource_key(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{raw_mode_index}/meta"
    )
}

fn mode_metadata_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/modes/sample_{sample_index:04}/mode_{raw_mode_index:04}.json")
}

fn mode_payload_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}/vector.bin")
}

fn mode_zarr_store_path() -> &'static str {
    "eigen/mode_fields.zarr"
}

fn mode_zarr_sample_group_path(sample_index: usize) -> String {
    format!("eigen/mode_fields.zarr/sample_{sample_index:04}")
}

fn mode_zarr_mode_group_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/mode_fields.zarr/sample_{sample_index:04}/mode_{raw_mode_index:04}")
}

fn mode_zarr_array_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "{}/vector_xyz_complex",
        mode_zarr_mode_group_path(sample_index, raw_mode_index)
    )
}

fn mode_zarr_chunk_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "{}/0.0.0",
        mode_zarr_array_path(sample_index, raw_mode_index)
    )
}

fn mode_vector_entries(value: &serde_json::Value, field: &str) -> Result<Vec<[f64; 3]>, RunError> {
    let entries = value
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: format!("requested mode field payload is missing {field}"),
        })?;
    if entries.is_empty() {
        return Err(RunError {
            message: format!("requested mode field payload {field} must not be empty"),
        });
    }
    entries
        .iter()
        .enumerate()
        .map(|(entry_index, entry)| {
            let components = entry.as_array().ok_or_else(|| RunError {
                message: format!(
                    "requested mode field payload {field}[{entry_index}] must be a Cartesian XYZ array"
                ),
            })?;
            if components.len() != 3 {
                return Err(RunError {
                    message: format!(
                        "requested mode field payload {field}[{entry_index}] must contain exactly three Cartesian components"
                    ),
                });
            }
            let mut vector = [0.0; 3];
            for (component_index, component) in components.iter().enumerate() {
                let numeric = component.as_f64().filter(|numeric| numeric.is_finite()).ok_or_else(|| {
                    RunError {
                        message: format!(
                            "requested mode field payload {field}[{entry_index}][{component_index}] must be finite"
                        ),
                    }
                })?;
                vector[component_index] = numeric;
            }
            Ok(vector)
        })
        .collect()
}

fn mode_payload_bytes(real: &[[f64; 3]], imag: &[[f64; 3]]) -> Result<Vec<u8>, RunError> {
    if real.is_empty() || imag.is_empty() || real.len() != imag.len() {
        return Err(RunError {
            message: format!(
                "requested mode field payload requires equal non-empty real/imag XYZ samples: real={}, imag={}",
                real.len(),
                imag.len()
            ),
        });
    }
    let sample_count = real.len();
    let mut bytes = Vec::with_capacity(sample_count * 6 * std::mem::size_of::<f64>());
    for (index, (real_sample, imag_sample)) in real.iter().zip(imag.iter()).enumerate() {
        for component in 0..3 {
            if !real_sample[component].is_finite() || !imag_sample[component].is_finite() {
                return Err(RunError {
                    message: format!(
                        "requested mode field payload contains non-finite Cartesian component at sample {index}, component {component}"
                    ),
                });
            }
            bytes.extend_from_slice(&real_sample[component].to_le_bytes());
            bytes.extend_from_slice(&imag_sample[component].to_le_bytes());
        }
    }
    Ok(bytes)
}

fn mode_amplitude_summary(amplitude: &serde_json::Value, sample_count: usize) -> serde_json::Value {
    let values: Vec<f64> = amplitude
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_f64()).collect())
        .unwrap_or_default();
    let max = values.iter().copied().fold(0.0, f64::max);
    let mean = if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    };
    serde_json::json!({
        "sample_count": sample_count,
        "max": max,
        "mean": mean,
    })
}

fn mode_component_summary(sample_count: usize) -> serde_json::Value {
    serde_json::json!({
        "real_sample_count": sample_count,
        "imag_sample_count": sample_count,
        "component_count": 3,
    })
}

fn zarr_group_artifact(path: impl Into<String>) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zgroup", path.into()),
        &serde_json::json!({
            "zarr_format": 2,
        }),
    )
}

fn mode_zarr_store_attrs_artifact() -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zattrs", mode_zarr_store_path()),
        &serde_json::json!({
            "fullmag_kind": "frequency_domain_mode_field_store",
            "schema_version": 1,
            "preferred_container": "zarr",
            "quantity_ids": ["delta_m"],
            "axes": ["sample", "mode", "spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "storage_layout": "aos_xyz_complex_pairs",
            "compatibility_binary_exports": true,
        }),
    )
}

fn mode_zarr_array_metadata_artifact(
    sample_index: usize,
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    let chunk_sample_count = sample_count.max(1);
    json_artifact(
        format!(
            "{}/.zarray",
            mode_zarr_array_path(sample_index, raw_mode_index)
        ),
        &serde_json::json!({
            "zarr_format": 2,
            "shape": [sample_count, 3, 2],
            "chunks": [chunk_sample_count, 3, 2],
            "dtype": "<f8",
            "compressor": serde_json::Value::Null,
            "fill_value": 0.0,
            "order": "C",
            "filters": serde_json::Value::Null,
            "dimension_separator": ".",
        }),
    )
}

fn mode_zarr_array_attrs_artifact(
    sample_index: usize,
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!(
            "{}/.zattrs",
            mode_zarr_array_path(sample_index, raw_mode_index)
        ),
        &serde_json::json!({
            "quantity_id": "delta_m",
            "unit": "1",
            "value_kind": "complex_spatial_vector",
            "component_basis": "global_xyz",
            "axes": ["spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "sample_index": sample_index,
            "raw_mode_index": raw_mode_index,
            "mode_field_sample_count": sample_count,
            "storage_layout": "aos_xyz_complex_pairs",
        }),
    )
}

fn write_eigen_v2_bundle(
    plan: &FemEigenPlanIR,
    summary_payload: &serde_json::Value,
    requested_modes: &std::collections::BTreeSet<u32>,
    auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
    sample_index: usize,
) -> Result<(), RunError> {
    let modes = summary_payload
        .get("modes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let k_vector = match plan.k_sampling.as_ref() {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) | None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let solver_model = summary_payload
        .get("solver_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let manifest_phase_convention = modes
        .first()
        .and_then(|mode| mode.get("phasor_convention"))
        .and_then(|value| value.as_str())
        .unwrap_or("exp_minus_i_omega_t");

    // A mode selected for field export is only visualizable after the complete
    // global Cartesian complex payload has been validated.  Modes not selected
    // by the author remain legitimate spectrum-only observations and never
    // receive a dangling field identifier.
    let mut visualizable_mode_indices = BTreeSet::new();
    for raw_mode_index in requested_modes.iter().copied().map(u64::from) {
        let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
        let legacy_mode = auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == legacy_path)
            .ok_or_else(|| RunError {
                message: format!(
                    "requested mode {raw_mode_index} has no legacy payload artifact for Cartesian field export"
                ),
            })
            .and_then(|artifact| {
                serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| {
                    RunError {
                        message: format!(
                            "requested mode {raw_mode_index} legacy payload is invalid JSON: {error}"
                        ),
                    }
                })
            })?;
        let real = mode_vector_entries(&legacy_mode, "real").map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        let imag = mode_vector_entries(&legacy_mode, "imag").map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        let _ = mode_payload_bytes(&real, &imag).map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        visualizable_mode_indices.insert(raw_mode_index);
    }

    let spectrum_v2_modes: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let mut mode = mode.clone();
            if let Some(object) = mode.as_object_mut() {
                object.remove("component_participation");
                object.insert(
                    "raw_mode_index".to_string(),
                    serde_json::json!(raw_mode_index),
                );
                object.insert("branch_id".to_string(), serde_json::json!(raw_mode_index));
                if visualizable_mode_indices.contains(&raw_mode_index) {
                    object.insert(
                        "mode_field_id".to_string(),
                        serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                    );
                    object.insert(
                        "mode_field_resource_key".to_string(),
                        serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                    );
                }
            }
            mode
        })
        .collect();
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_model": summary_payload["solver_kind"],
        "sample_count": 1,
        "mode_count": spectrum_v2_modes.len(),
        "samples": [{
            "sample_index": sample_index,
            "label": label,
            "k_vector": k_vector,
            "path_s": 0.0,
            "segment_index": 0,
            "t_in_segment": 0.0,
            "external_field_a_per_m": plan.external_field,
            "mesh_id": plan.mesh_name,
            "topology_revision": plan.mesh.topology_fingerprint_v6(),
            "modes": spectrum_v2_modes,
        }],
    });
    auxiliary_artifacts.push(json_artifact("eigen/spectrum.v2.json", &spectrum_v2)?);

    let participation_solver_device = if solver_model.contains("gpu") {
        "gpu"
    } else {
        "cpu"
    };
    let spectrum_v3_modes = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let participation = match mode.get("component_participation") {
                Some(value) => serde_json::from_value::<
                    crate::eigen::ModalParticipationObservable,
                >(value.clone())
                .map_err(|error| RunError {
                    message: format!(
                        "mode {raw_mode_index} has invalid component participation: {error}"
                    ),
                })?,
                None => crate::eigen::ModalParticipationObservable::unavailable_without_context(
                    participation_solver_device,
                ),
            };
            let mut mode = mode.clone();
            let object = mode.as_object_mut().ok_or_else(|| RunError {
                message: format!("mode {raw_mode_index} summary is not a JSON object"),
            })?;
            object.insert(
                "mode_id".to_string(),
                serde_json::json!(format!(
                    "sample-{sample_index:04}/mode-{raw_mode_index:04}"
                )),
            );
            object.insert(
                "raw_mode_index".to_string(),
                serde_json::json!(raw_mode_index),
            );
            object.insert("branch_id".to_string(), serde_json::json!(raw_mode_index));
            object.insert(
                "component_participation".to_string(),
                serde_json::to_value(participation).map_err(|error| RunError {
                    message: format!(
                        "mode {raw_mode_index} component participation cannot serialize: {error}"
                    ),
                })?,
            );
            if visualizable_mode_indices.contains(&raw_mode_index) {
                object.insert(
                    "mode_field_id".to_string(),
                    serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                );
                object.insert(
                    "mode_field_resource_key".to_string(),
                    serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                );
            }
            Ok(mode)
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    auxiliary_artifacts.push(json_artifact(
        "eigen/spectrum.v3.json",
        &serde_json::json!({
            "schema_version": "eigen_spectrum.v3",
            "solver_model": summary_payload["solver_kind"],
            "sample_count": 1,
            "mode_count": spectrum_v3_modes.len(),
            "samples": [{
                "sample_id": format!("bias-field-sample-{sample_index:04}"),
                "sample_index": sample_index,
                "label": label,
                "k_vector": k_vector,
                "path_s": 0.0,
                "segment_index": 0,
                "t_in_segment": 0.0,
                "external_field_a_per_m": plan.external_field,
                "mesh_id": plan.mesh_name,
                "topology_revision": plan.mesh.topology_fingerprint_v6(),
                "modes": spectrum_v3_modes,
            }],
        }),
    )?);

    let branches: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let mut point = serde_json::json!({
                "branch_id": raw_mode_index,
                "cluster_id": mode["cluster_id"],
                "multiplicity": mode["multiplicity"],
                "label": format!("mode_{raw_mode_index:04}"),
                "points": [{
                    "sample_index": sample_index,
                    "raw_mode_index": raw_mode_index,
                    "frequency_hz": mode["frequency_hz"],
                    "frequency_real_hz": mode["frequency_real_hz"],
                    "frequency_imag_hz": mode["frequency_imag_hz"],
                    "angular_frequency_rad_per_s": mode["angular_frequency_rad_per_s"],
                    "tracking_confidence": 1.0,
                    "tracking_score_source": "seed",
                    "modal_overlap_available": false,
                    "overlap_prev": null,
                }],
            });
            if visualizable_mode_indices.contains(&raw_mode_index) {
                let point_object = point["points"][0]
                    .as_object_mut()
                    .expect("branch point must remain an object");
                point_object.insert(
                    "mode_field_id".to_string(),
                    serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                );
                point_object.insert(
                    "mode_field_resource_key".to_string(),
                    serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                );
            }
            point
        })
        .collect();
    auxiliary_artifacts.push(json_artifact(
        "eigen/branches.v2.json",
        &serde_json::json!({
            "schema_version": "eigen_branches.v2",
            "solver_model": summary_payload["solver_kind"],
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
            "branches": branches,
            "diagnostics": {
                "tracking_score_source": "seed_only",
                "modal_overlap_available": false,
            },
        }),
    )?);
    if !auxiliary_artifacts
        .iter()
        .any(|artifact| artifact.relative_path == "eigen/dispersion.csv")
    {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(
                plan.k_sampling.as_ref(),
                &summary_payload["modes"],
                &visualizable_mode_indices,
            )
            .into_bytes(),
        });
    }

    let mut mode_metadata_paths = Vec::new();
    let mut mode_resource_keys = Vec::new();
    let mut wrote_mode_zarr_store = false;
    for raw_mode_index in requested_modes.iter().copied().map(u64::from) {
        let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
        let legacy_mode = auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == legacy_path)
            .ok_or_else(|| RunError {
                message: format!("requested mode {raw_mode_index} disappeared before publication"),
            })
            .and_then(|artifact| {
                serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| {
                    RunError {
                        message: format!(
                            "requested mode {raw_mode_index} legacy payload is invalid JSON: {error}"
                        ),
                    }
                })
            })?;
        let real = mode_vector_entries(&legacy_mode, "real")?;
        let imag = mode_vector_entries(&legacy_mode, "imag")?;
        let sample_count = real.len();
        let source_node_count = plan.mesh.nodes.len();
        if sample_count != source_node_count {
            return Err(RunError {
                message: format!(
                    "requested mode {raw_mode_index} payload node count {sample_count} does not match source mesh node count {source_node_count}"
                ),
            });
        }
        let metadata_path = mode_metadata_path(sample_index, raw_mode_index);
        let payload_path = mode_payload_path(sample_index, raw_mode_index);
        let zarr_array_path = mode_zarr_array_path(sample_index, raw_mode_index);
        let zarr_chunk_path = mode_zarr_chunk_path(sample_index, raw_mode_index);
        let field_id = mode_field_id(sample_index, raw_mode_index);
        let field_resource = mode_field_resource_key(sample_index, raw_mode_index);
        let payload_bytes = mode_payload_bytes(&real, &imag)?;
        let payload_sha256 = format!("sha256:{:x}", Sha256::digest(&payload_bytes));
        let mut metadata = serde_json::json!({
            "schema_version": "eigen_mode.v2",
            "solver_model": summary_payload["solver_kind"],
            "sample_index": sample_index,
            "raw_mode_index": raw_mode_index,
            "branch_id": raw_mode_index,
            "frequency_hz": legacy_mode["frequency_hz"],
            "frequency_real_hz": legacy_mode["frequency_real_hz"],
            "frequency_imag_hz": legacy_mode["frequency_imag_hz"],
            "angular_frequency_rad_per_s": legacy_mode["angular_frequency_rad_per_s"],
            "eigenvalue_real": legacy_mode["eigenvalue_real"],
            "eigenvalue_imag": legacy_mode["eigenvalue_imag"],
            "normalization": legacy_mode["normalization"],
            "damping_policy": legacy_mode["damping_policy"],
            "source_mesh_identity": {
                "mesh_id": plan.mesh_name,
                "topology_fingerprint": plan.mesh.topology_fingerprint_v6(),
                "indexing": "full_domain_node_order",
                "node_count": source_node_count,
            },
            "payload_sha256": payload_sha256,
        });
        if let Some(object) = metadata.as_object_mut() {
            object.insert("mode_field_id".to_string(), serde_json::json!(field_id));
            object.insert(
                "mode_field_resource_key".to_string(),
                serde_json::json!(field_resource),
            );
            object.insert(
                "residual_norm".to_string(),
                legacy_mode["residual_norm"].clone(),
            );
            object.insert(
                "residual_absolute_l2".to_string(),
                legacy_mode["residual_absolute_l2"].clone(),
            );
            object.insert(
                "residual_relative_l2".to_string(),
                legacy_mode["residual_relative_l2"].clone(),
            );
            object.insert(
                "residual_linf".to_string(),
                legacy_mode["residual_linf"].clone(),
            );
            object.insert("mass_norm".to_string(), legacy_mode["mass_norm"].clone());
            for key in [
                "cluster_id",
                "cluster_size",
                "multiplicity",
                "q_dof_count",
                "phi_dof_count",
                "native_q_phi_payload",
                "q_real",
                "q_imag",
                "phi_real",
                "phi_imag",
                "external_field_a_per_m",
                "assembly_kind",
                "operator_input_signature_sha256",
                "phase_constraint_sha256",
                "equilibrium_artifact_sha256",
                "linearization_state_sha256",
                "periodic_mesh_certificate_sha256",
                "relax_to_eigen_handoff_sha256",
                "source_mesh_topology_sha256",
            ] {
                if legacy_mode.get(key).is_some() {
                    object.insert(key.to_string(), legacy_mode[key].clone());
                }
            }
            if let Some(block_residuals) = legacy_mode.get("block_residuals") {
                object.insert("block_residuals".to_string(), block_residuals.clone());
            }
            for key in [
                "angular_frequency_imag_rad_per_s",
                "complex_frequency_convention",
                "damping_rate_hz",
                "linewidth_fwhm_hz",
            ] {
                if legacy_mode.get(key).is_some() {
                    object.insert(key.to_string(), legacy_mode[key].clone());
                }
            }
            object.insert(
                "tangent_leakage_mean_abs".to_string(),
                legacy_mode["tangent_leakage_mean_abs"].clone(),
            );
            object.insert(
                "tangent_leakage_max_abs".to_string(),
                legacy_mode["tangent_leakage_max_abs"].clone(),
            );
            object.insert(
                "omega_rad_s".to_string(),
                legacy_mode["omega_rad_s"].clone(),
            );
            object.insert(
                "phasor_convention".to_string(),
                legacy_mode["phasor_convention"].clone(),
            );
            object.insert(
                "eigenvalue_mapping".to_string(),
                legacy_mode["eigenvalue_mapping"].clone(),
            );
            object.insert(
                "gamma_rad_s_T".to_string(),
                legacy_mode["gamma_rad_s_T"].clone(),
            );
            object.insert(
                "gamma0_rad_s_per_A_m".to_string(),
                legacy_mode["gamma0_rad_s_per_A_m"].clone(),
            );
            object.insert(
                "mu0_T_m_per_A".to_string(),
                legacy_mode["mu0_T_m_per_A"].clone(),
            );
            object.insert(
                "dominant_polarization".to_string(),
                legacy_mode["dominant_polarization"].clone(),
            );
            object.insert("k_vector".to_string(), legacy_mode["k_vector"].clone());
            object.insert(
                "value_kind".to_string(),
                serde_json::json!("complex_spatial_vector"),
            );
            object.insert(
                "component_basis".to_string(),
                serde_json::json!("global_xyz"),
            );
            object.insert("component_count".to_string(), serde_json::json!(3));
            object.insert("components".to_string(), serde_json::json!(["x", "y", "z"]));
            object.insert(
                "payload_encoding".to_string(),
                serde_json::json!("f64_interleaved_real_imag_xyz"),
            );
            object.insert(
                "binary_layout".to_string(),
                serde_json::json!("complex_f64_pairs_little_endian"),
            );
            object.insert(
                "complex_pair_count".to_string(),
                serde_json::json!(sample_count * 3),
            );
            object.insert(
                "payload_value_count".to_string(),
                serde_json::json!(sample_count * 6),
            );
            object.insert(
                "available_views".to_string(),
                serde_json::json!([
                    "complex",
                    "real",
                    "imag",
                    "abs",
                    "amplitude",
                    "phase",
                    "phase_rotated_real"
                ]),
            );
            object.insert(
                "default_view".to_string(),
                serde_json::json!("phase_rotated_real"),
            );
            object.insert("default_phase_rad".to_string(), serde_json::json!(0.0));
            object.insert(
                "mode_field_sample_count".to_string(),
                serde_json::json!(sample_count),
            );
            object.insert(
                "amplitude_summary".to_string(),
                mode_amplitude_summary(&legacy_mode["amplitude"], sample_count),
            );
            object.insert(
                "component_summary".to_string(),
                mode_component_summary(sample_count),
            );
            object.insert("storage_format".to_string(), serde_json::json!("zarr"));
            object.insert(
                "zarr_store_path".to_string(),
                serde_json::json!(mode_zarr_store_path()),
            );
            object.insert(
                "zarr_array_path".to_string(),
                serde_json::json!(zarr_array_path),
            );
            object.insert(
                "zarr_chunk_path".to_string(),
                serde_json::json!(zarr_chunk_path.clone()),
            );
            object.insert("zarr_dtype".to_string(), serde_json::json!("<f8"));
            object.insert(
                "zarr_shape".to_string(),
                serde_json::json!([sample_count, 3, 2]),
            );
            object.insert(
                "zarr_chunk_shape".to_string(),
                serde_json::json!([sample_count.max(1), 3, 2]),
            );
            object.insert("zarr_compressor".to_string(), serde_json::Value::Null);
            object.insert(
                "compatibility_binary_payload_path".to_string(),
                serde_json::json!(payload_path.clone()),
            );
        }
        auxiliary_artifacts.push(json_artifact(metadata_path.clone(), &metadata)?);
        if !wrote_mode_zarr_store {
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_store_path())?);
            auxiliary_artifacts.push(mode_zarr_store_attrs_artifact()?);
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_sample_group_path(
                sample_index,
            ))?);
            wrote_mode_zarr_store = true;
        }
        auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_mode_group_path(
            sample_index,
            raw_mode_index,
        ))?);
        auxiliary_artifacts.push(mode_zarr_array_metadata_artifact(
            sample_index,
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(mode_zarr_array_attrs_artifact(
            sample_index,
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(binary_artifact(zarr_chunk_path, payload_bytes.clone()));
        auxiliary_artifacts.push(binary_artifact(payload_path, payload_bytes));
        mode_metadata_paths.push(metadata_path);
        mode_resource_keys.push(mode_meta_resource_key(sample_index, raw_mode_index));
    }

    auxiliary_artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &modal_solver_diagnostics_json(plan, solver_model, modes.len()),
    )?);

    let has_mode_fields = !mode_metadata_paths.is_empty();
    let spectrum_revision =
        published_artifact_sha256(auxiliary_artifacts, "eigen/spectrum.v2.json")?;
    let branches_revision =
        published_artifact_sha256(auxiliary_artifacts, "eigen/branches.v2.json")?;
    let mut manifest = serde_json::json!({
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain",
        "study_product": "modal_eigen",
        "stage_kind": "eigenmodes",
        "status": "ready",
        "complete": true,
        "physics": {
            "analysis_family": "magnetic_frequency_domain",
            "phase_convention": manifest_phase_convention,
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": normalization_label(plan.normalization),
        },
        "artifacts": {
            "spectrum_v2_path": "eigen/spectrum.v2.json",
            "branches_v2_path": "eigen/branches.v2.json",
            "dispersion_csv_path": "eigen/dispersion.csv",
            "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json",
            "mode_field_zarr_store_path": if has_mode_fields {
                serde_json::json!(mode_zarr_store_path())
            } else {
                serde_json::Value::Null
            },
            "mode_field_storage_format": if has_mode_fields { "zarr" } else { "none" },
            "mode_metadata_paths": mode_metadata_paths,
        },
        "resources": {
            "spectrum_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
            "branches_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
            "dispersion_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
            "mode_field_resources": mode_resource_keys,
        },
        "diagnostics": {
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
        },
        "cross_artifact_refs": [
            {
                "relation": "source_spectrum",
                "artifact": "eigen/spectrum.v2.json",
                "revision": spectrum_revision,
            },
            {
                "relation": "source_branches",
                "artifact": "eigen/branches.v2.json",
                "revision": branches_revision,
            },
        ],
    });
    if summary_payload
        .get("solver_diagnostics")
        .and_then(|value| value.get("linearization_state_sha256"))
        .is_some()
    {
        if let Some(artifacts) = manifest
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            artifacts.insert(
                "equilibrium_artifact_v7_path".to_string(),
                serde_json::json!("eigen/metadata/equilibrium_artifact.v7.json"),
            );
            artifacts.insert(
                "linearization_state_v6_path".to_string(),
                serde_json::json!("eigen/metadata/linearization_state.v6.json"),
            );
        }
    }
    if let (Some(manifest_object), Some(diagnostics_object)) = (
        manifest.as_object_mut(),
        summary_payload["solver_diagnostics"].as_object(),
    ) {
        for key in [
            "physics_contract_version",
            "operator_dictionary_version",
            "implementation_state",
            "validation_state",
            "validated_scope",
            "requested_execution",
            "resolved_execution",
            "assembly_kind",
            "operator_input_signature_sha256",
            "phase_constraint_sha256",
            "equilibrium_artifact_sha256",
            "linearization_state_sha256",
            "periodic_mesh_certificate_sha256",
            "relax_to_eigen_handoff_sha256",
            "source_mesh_topology_sha256",
            "boundary_gauge",
            "spectral",
            "block_residuals",
            "device_transfer_audit",
        ] {
            if let Some(value) = diagnostics_object.get(key) {
                manifest_object.insert(key.to_string(), value.clone());
            }
        }
        if let Some(validation) = plan.dispersion_validation.as_ref() {
            manifest_object.insert(
                "validation".to_string(),
                serde_json::json!({"dispersion_validation": validation}),
            );
        } else {
            // Keep the manifest schema explicit for direct single-point modal
            // solves.  Consumers distinguish an empty validation object
            // (executed but not analytically certified) from a missing field.
            manifest_object.insert("validation".to_string(), serde_json::json!({}));
        }
    }
    auxiliary_artifacts.push(json_artifact(
        "frequency_domain/manifest.v1.json",
        &manifest,
    )?);

    Ok(())
}

fn normalization_label(normalization: EigenNormalizationIR) -> &'static str {
    match normalization {
        EigenNormalizationIR::UnitL2 => "unit_l2",
        EigenNormalizationIR::UnitMaxAmplitude => "unit_max_amplitude",
    }
}

fn modal_solver_diagnostics_json(
    plan: &FemEigenPlanIR,
    solver_model: &str,
    mode_count: usize,
) -> serde_json::Value {
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_model": solver_model,
        "resolved_solver_family": solver_model,
        "spectral_transform": "none",
        "algebraic_form": "reference_effective_field_generalized",
        "matrix_equation": "K u = lambda M u",
        "phasor_convention": "not_applicable_real_reference",
        "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
        "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
        "production_gyrotropic_mapping": false,
        "sample_count": 1,
        "mode_count": mode_count,
        "requested_mode_count": plan.count,
        "normalization": normalization_label(plan.normalization),
    });
    merge_modal_transport_diagnostics(&mut diagnostics, modal_tangent_transport_diagnostics(plan));
    if let fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz,
        frequency_max_hz,
    } = plan.target
    {
        let window_width = frequency_max_hz - frequency_min_hz;
        let relative_width = if frequency_min_hz > 0.0 {
            window_width / frequency_min_hz
        } else {
            0.0
        };
        let subwindow_count = (relative_width / 0.35).ceil().max(1.0).min(16.0) as usize;
        let guard_fraction = 0.25;
        let mut subwindows = Vec::with_capacity(subwindow_count);
        let mut resolved_min_hz = frequency_min_hz;
        let mut resolved_max_hz = frequency_max_hz;
        for index in 0..subwindow_count {
            let sub_min = frequency_min_hz + index as f64 * window_width / subwindow_count as f64;
            let sub_max =
                frequency_min_hz + (index + 1) as f64 * window_width / subwindow_count as f64;
            let sub_width = sub_max - sub_min;
            let search_min = (sub_min - guard_fraction * sub_width).max(0.0);
            let search_max = sub_max + guard_fraction * sub_width;
            let shift_frequency_hz = 0.5 * (sub_min + sub_max);
            resolved_min_hz = resolved_min_hz.min(search_min);
            resolved_max_hz = resolved_max_hz.max(search_max);
            subwindows.push(serde_json::json!({
                "index": index,
                "requested_hz": [sub_min, sub_max],
                "search_hz": [search_min, search_max],
                "shift_hz": shift_frequency_hz,
                "shift_frequency_hz": shift_frequency_hz,
                "shift_omega_rad_s": 2.0 * std::f64::consts::PI * shift_frequency_hz,
                "outer_iterations": 0,
                "linear_iterations_total": 0,
                "candidate_modes": 0,
                "accepted_modes": 0,
                "residual_max": 0.0,
                "stop_reason": "window_exhausted",
            }));
        }
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "requested_window_hz".to_string(),
                serde_json::json!([frequency_min_hz, frequency_max_hz]),
            );
            object.insert(
                "resolved_search_window_hz".to_string(),
                serde_json::json!([resolved_min_hz, resolved_max_hz]),
            );
            object.insert(
                "window_completeness".to_string(),
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": 0,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                }),
            );
            object.insert("subwindows".to_string(), serde_json::json!(subwindows));
        }
    }
    if let Some(reason) = native_cpu_modal_window_rejection_reason(plan) {
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "production_cpu_rejection_reason".to_string(),
                serde_json::json!(reason),
            );
            object.insert(
                "production_cpu_rejection_scope".to_string(),
                serde_json::json!(native_cpu_modal_window_rejection_scope(reason)),
            );
            insert_native_cpu_modal_window_rejection_contract(object, reason);
        }
    }
    diagnostics
}

pub(crate) fn modal_tangent_transport_diagnostics(plan: &FemEigenPlanIR) -> serde_json::Value {
    if !matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return serde_json::json!({
            "basis_transport_policy": "not_applicable",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
        });
    }

    let topology = match MeshTopology::from_ir(&plan.mesh) {
        Ok(topology) => topology,
        Err(error) => {
            return serde_json::json!({
                "basis_transport_policy": "unavailable",
                "basis_transport_error": format!("MeshTopology: {}", error),
                "floquet_tangent_frame_max_mismatch": f64::NAN,
                "floquet_tangent_transport_max_nonunitarity": f64::NAN,
            });
        }
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    let bases = tangent_bases(&plan.equilibrium_magnetization);
    let mut max_mismatch: f64 = 0.0;
    let mut max_nonunitarity: f64 = 0.0;
    for (_, node_a, node_b) in selected_pairs {
        let node_a = node_a as usize;
        let node_b = node_b as usize;
        if node_a >= bases.len()
            || node_b >= bases.len()
            || topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let transport = tangent_transport_matrix(bases[node_a], bases[node_b]);
        max_mismatch = max_mismatch.max(tangent_frame_identity_mismatch(
            bases[node_a],
            bases[node_b],
        ));
        max_nonunitarity = max_nonunitarity.max(tangent_transport_nonunitarity(transport));
    }
    serde_json::json!({
        "basis_transport_policy": if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "tangent_frame_transport"
        } else {
            "tangent_frame_identity"
        },
        "floquet_tangent_frame_max_mismatch": max_mismatch,
        "floquet_tangent_transport_max_nonunitarity": max_nonunitarity,
    })
}

fn merge_modal_transport_diagnostics(target: &mut serde_json::Value, transport: serde_json::Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(transport_object) = transport.as_object() else {
        return;
    };
    for (key, value) in transport_object {
        target_object.insert(key.clone(), value.clone());
    }
}

fn damping_policy_label(policy: EigenDampingPolicyIR) -> &'static str {
    match policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

fn damping_imaginary_factor(damping: f64, policy: EigenDampingPolicyIR) -> f64 {
    match policy {
        EigenDampingPolicyIR::Ignore => 0.0,
        EigenDampingPolicyIR::Include => damping.abs() / (1.0 + damping * damping),
    }
}

fn spin_wave_bc_label(bc: SpinWaveBoundaryConditionIR) -> &'static str {
    match bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

fn spin_wave_bc_json(bc: &SpinWaveBoundaryConditionIR) -> serde_json::Value {
    serde_json::json!({
        "kind": spin_wave_bc_label(bc.clone()),
        "boundary_pair_id": bc.boundary_pair_id(),
        "pair_ids": bc.boundary_pair_ids(),
        "phase_convention": bc.phase_convention(),
        "surface_anisotropy_ks": bc.surface_anisotropy_ks(),
        "surface_anisotropy_axis": bc.surface_anisotropy_axis(),
    })
}

fn solver_kind_label(plan: &FemEigenPlanIR) -> &'static str {
    if matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "cpu_full_2x2_phase_reduced_floquet"
        } else {
            "cpu_phase_reduced_floquet"
        }
    } else {
        match (plan.operator.kind, plan.damping_policy) {
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Ignore) => {
                "cpu_full_2x2_symmetric"
            }
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Include) => {
                "cpu_full_2x2_damped"
            }
            (_, EigenDampingPolicyIR::Ignore) => "cpu_reference_symmetric",
            (_, EigenDampingPolicyIR::Include) => "cpu_generalized_eigen",
        }
    }
}

fn solver_notes(plan: &FemEigenPlanIR, complex_reduction: bool, use_sparse: bool) -> &'static str {
    if complex_reduction && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "phase-aware Floquet reduction on the full 2x2 tangent-frame block with phase*(T_node^T T_root) transport"
    } else if complex_reduction {
        "phase-aware periodic reduction on a real doubled Hermitian block"
    } else if use_sparse && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "sparse LOBPCG on full 2×2 Herring-Kittel block operator (2N DOF)"
    } else if use_sparse {
        "sparse LOBPCG iterative eigensolver for large DOF systems"
    } else if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "full 2×2 Herring-Kittel block operator in tangent plane (2N DOF)"
    } else if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        "damping artifacts use first-order alpha linewidth correction over the CPU reference eigenbasis"
    } else {
        "cpu reference symmetric eigen solve"
    }
}

fn solver_capabilities(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut capabilities = vec!["cpu_reference_eigen", "artifact_backed_analyze"];
    if use_sparse {
        capabilities.push("sparse_lobpcg");
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        capabilities.push("full_2x2_herring_kittel");
    }
    match plan.spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => capabilities.push("free_bc"),
        SpinWaveBoundaryKindIR::Pinned => capabilities.push("pinned_bc"),
        SpinWaveBoundaryKindIR::Periodic => capabilities.push("periodic_zero_phase"),
        SpinWaveBoundaryKindIR::Floquet => capabilities.push("floquet_phase_reduction"),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => {
            capabilities.push("surface_anisotropy_boundary_term")
        }
    }
    if plan.enable_exchange {
        capabilities.push("exchange");
    }
    if plan.enable_demag {
        match resolved_demag_realization(plan)
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
        {
            fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => {
                capabilities.push("demag_poisson_dirichlet")
            }
            fullmag_ir::ResolvedFemDemagIR::PoissonRobin => {
                capabilities.push("demag_poisson_robin")
            }
            fullmag_ir::ResolvedFemDemagIR::Bem => capabilities.push("demag_bem"),
            fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => {
                capabilities.push("demag_fredkin_koehler")
            }
            fullmag_ir::ResolvedFemDemagIR::Fmm => capabilities.push("demag_fmm"),
        }
    }
    if plan.external_field.is_some() {
        capabilities.push("zeeman");
    }
    if plan.interfacial_dmi.is_some() {
        capabilities.push("interfacial_dmi");
    }
    if plan.bulk_dmi.is_some() {
        capabilities.push("bulk_dmi");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        capabilities.push("damping_linewidth_metadata");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        capabilities.push("frequency_window_filter");
    }
    if complex_reduction {
        capabilities.push("complex_mode_projection");
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            capabilities.push("floquet_tangent_frame_transport");
        }
    }
    capabilities
}

fn solver_limitations(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut limitations = Vec::new();
    if use_sparse {
        limitations.push("sparse_lobpcg_may_miss_modes_near_degeneracy");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        limitations.push("frequency_window_is_filtered_after_reference_solve");
        limitations.push("frequency_window_sparse_lobpcg_uses_oversampled_lowest_candidates");
        limitations.push("no_shift_invert_or_feast_window_solver_yet");
    }
    if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        limitations.push("scalar_projection_only_accurate_for_uniform_equilibrium");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        limitations.push("no_generalized_qz_backend");
        limitations.push("damping_is_first_order_linewidth_correction");
    }
    if complex_reduction {
        limitations.push("floquet_uses_phase_reduced_hermitian_block");
        if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            limitations.push("scalar_floquet_requires_identity_tangent_frame_transport");
        }
    }
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        limitations.push("dmi_operator_is_cpu_first_reference_approximation");
    }
    if matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy
    ) {
        limitations.push("surface_anisotropy_requires_exposed_boundary_faces");
    }
    limitations
}

fn resolved_demag_realization(plan: &FemEigenPlanIR) -> Option<fullmag_ir::ResolvedFemDemagIR> {
    if !plan.enable_demag {
        return None;
    }
    Some(
        plan.demag_realization
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
    )
}

fn demag_realization_label(realization: fullmag_ir::ResolvedFemDemagIR) -> &'static str {
    realization.provenance_name()
}

fn equilibrium_source_json(equilibrium: &EquilibriumSourceIR) -> serde_json::Value {
    match equilibrium {
        EquilibriumSourceIR::Provided => serde_json::json!({ "kind": "provided" }),
        EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

fn k_vector_json(k_sampling: Option<&KSamplingIR>) -> serde_json::Value {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => serde_json::json!(k_vector),
        Some(KSamplingIR::Path { .. }) => serde_json::json!([0.0, 0.0, 0.0]),
        None => serde_json::Value::Null,
    }
}

fn dispersion_csv(k_sampling: Option<&KSamplingIR>, modes: &serde_json::Value) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let mut csv = String::from("mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n");
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            csv.push_str(&format!(
                "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}\n",
                entry["index"].as_u64().unwrap_or(0),
                k_vector[0],
                k_vector[1],
                k_vector[2],
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
            ));
        }
    }
    csv
}

fn dispersion_v2_csv(
    k_sampling: Option<&KSamplingIR>,
    modes: &serde_json::Value,
    visualizable_mode_indices: &BTreeSet<u64>,
) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let mut csv = String::from(
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key\n",
    );
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            let raw_mode_index = entry["index"].as_u64().unwrap_or(0);
            let (field_id, field_resource_key) =
                if visualizable_mode_indices.contains(&raw_mode_index) {
                    (
                        mode_field_id(0, raw_mode_index),
                        mode_field_resource_key(0, raw_mode_index),
                    )
                } else {
                    (String::new(), String::new())
                };
            let residual_norm = entry["residual_norm"]
                .as_f64()
                .map(|value| format!("{value:.16e}"))
                .unwrap_or_default();
            let line_width_hz = entry["frequency_imag_hz"]
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| format!("{:.16e}", 2.0 * value))
                .unwrap_or_default();
            csv.push_str(&format!(
                "0,{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{:.16e},{:.16e},{},{},{},seed,{},{}\n",
                0.0,
                k_vector[0],
                k_vector[1],
                k_vector[2],
                label,
                raw_mode_index,
                raw_mode_index,
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
                line_width_hz,
                residual_norm,
                "",
                field_id,
                field_resource_key,
            ));
        }
    }
    csv
}

fn dot(a: Vector3, b: Vector3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vector3, b: Vector3) -> Vector3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: Vector3) -> f64 {
    dot(a, a).sqrt()
}

fn normalize_vector(a: Vector3) -> Vector3 {
    let magnitude = norm(a);
    if magnitude <= 1e-30 {
        [1.0, 0.0, 0.0]
    } else {
        scale_vector(a, 1.0 / magnitude)
    }
}

fn scale_vector(a: Vector3, factor: f64) -> Vector3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

fn add_vector(a: Vector3, b: Vector3) -> Vector3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/// Classify the dominant polarization character of a spin-wave mode.
///
/// Heuristics (all for the real scalar LLG linearization):
/// - `"uniform"`: mode amplitude is spatially homogeneous (Kittel / macrospin mode).
///   Criterion: mean amplitude over active nodes ≥ 60 % of the maximum.
/// - `"op"`: equilibrium is predominantly out-of-plane (|⟨mz⟩| > 0.7 ⇒ mz-dominated modes).
/// - `"ip"`: default for in-plane equilibrium configurations.
/// - `"mixed"`: fallback when the active node set is empty or max amplitude is degenerate.
fn classify_polarization(
    amplitude: &[f64],
    active_nodes: &[usize],
    equilibrium: &[Vector3],
    max_amplitude: f64,
) -> &'static str {
    if active_nodes.is_empty() || max_amplitude < 1e-30 {
        return "mixed";
    }

    let n = active_nodes.len() as f64;

    // Spatial uniformity: mean / max over active nodes.
    let mean_amplitude: f64 = active_nodes.iter().map(|&i| amplitude[i]).sum::<f64>() / n;
    if mean_amplitude / max_amplitude > 0.6 {
        return "uniform";
    }

    // Determine equilibrium orientation: average |mz| over active nodes.
    let mean_mz_abs: f64 = if equilibrium.len() > *active_nodes.iter().max().unwrap_or(&0) {
        active_nodes
            .iter()
            .map(|&i| equilibrium[i][2].abs())
            .sum::<f64>()
            / n
    } else {
        0.0
    };

    if mean_mz_abs > 0.7 {
        "op"
    } else {
        "ip"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frozen_v2_record_fixture() -> AcceptedFemRelaxStageHandoffV2Record {
        let completion = fullmag_ir::StageCompletionIR {
            status: "completed".to_string(),
            converged: true,
            reason: Some(fullmag_ir::StageStopReason::Torque),
            metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
            metric_name: Some("max_torque_apm".to_string()),
            metric_value: Some(1.0),
            threshold: Some(2.0),
        };
        AcceptedFemRelaxStageHandoffV2Record {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
            source_run_id: "run-relax".to_string(),
            source_stage_id: "stage-000".to_string(),
            source_stage_kind: "flat_relax".to_string(),
            stage_fem_mesh_generation_id: format!("sha256:{}", "1".repeat(64)),
            source_mesh_topology_sha256: format!("sha256:{}", "2".repeat(64)),
            node_count: 4,
            indexing_sha256: format!("sha256:{}", "3".repeat(64)),
            part_registry_sha256: format!("sha256:{}", "4".repeat(64)),
            completion_sha256: format!("sha256:{}", "5".repeat(64)),
            completion,
            acceptance: AcceptedEquilibriumCriterion {
                criterion: "torque".to_string(),
                metric_kind: fullmag_ir::StageMetricKind::MaxTorqueApm,
                metric_value: 1.0,
                threshold: 2.0,
                unit: "A/m".to_string(),
                status: "completed".to_string(),
                converged: true,
                stop_reason: fullmag_ir::StageStopReason::Torque,
            },
            equilibrium_content_sha256: format!("sha256:{}", "6".repeat(64)),
            content_sha256: String::new(),
        }
    }

    #[test]
    fn accepted_relax_stage_handoff_v2_hash_is_frozen_golden() {
        let record = frozen_v2_record_fixture();

        assert_eq!(
            relax_stage_handoff_v2_content_sha256(&record).unwrap(),
            "sha256:b50d79726a4593164767a289f05fb1ffa45c74b43add44324873da35fd82bc08"
        );
    }

    #[test]
    fn accepted_relax_stage_handoff_v2_rejects_extended_payload() {
        let mut value = serde_json::to_value(frozen_v2_record_fixture()).unwrap();
        value.as_object_mut().unwrap().insert(
            "certified_fields_content_sha256".to_string(),
            serde_json::json!(format!("sha256:{}", "7".repeat(64))),
        );

        let error = serde_json::from_value::<AcceptedFemRelaxStageHandoffV2Record>(value)
            .expect_err("frozen v2 must reject fields introduced by v3");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn accepted_relax_stage_handoff_v3_hash_uses_a_distinct_namespace_and_binds_source_signatures()
    {
        let baseline = AcceptedFemRelaxStageHandoffV3HashPreimage {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
            legacy_v2_content_sha256: format!("sha256:{}", "1".repeat(64)),
            acceptance_certificate_sha256: format!("sha256:{}", "2".repeat(64)),
            certified_fields_content_sha256: format!("sha256:{}", "3".repeat(64)),
            equilibrium_material_signature: format!("sha256:{}", "4".repeat(64)),
            equilibrium_static_physics_signature: format!("sha256:{}", "5".repeat(64)),
            equilibrium_boundary_signature: format!("sha256:{}", "6".repeat(64)),
        };
        let baseline_digest = relax_stage_handoff_v3_content_sha256(&baseline).unwrap();

        let mut changed = baseline.clone();
        changed.equilibrium_boundary_signature = format!("sha256:{}", "7".repeat(64));
        assert_ne!(
            baseline_digest,
            relax_stage_handoff_v3_content_sha256(&changed).unwrap()
        );
        assert_ne!(
            baseline_digest,
            relax_stage_handoff_v2_content_sha256(&frozen_v2_record_fixture()).unwrap(),
            "v2 and v3 must never share a hash namespace"
        );
    }

    #[test]
    fn equilibrium_and_modal_identity_signatures_are_separated_by_semantics() {
        use crate::fem::equilibrium_identity::{
            EquilibriumIdentitySignaturesV1, ModalIdentitySignaturesV1,
        };

        let plan = minimal_native_modal_plan();
        let source = EquilibriumIdentitySignaturesV1::from_eigen_plan(&plan).unwrap();
        let modal = ModalIdentitySignaturesV1::from_eigen_plan(&plan).unwrap();

        let mut operator_changed = plan.clone();
        operator_changed.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        assert_eq!(
            source,
            EquilibriumIdentitySignaturesV1::from_eigen_plan(&operator_changed).unwrap(),
            "modal operator fields must not contaminate source equilibrium identity"
        );
        assert_ne!(
            modal.modal_operator_signature,
            ModalIdentitySignaturesV1::from_eigen_plan(&operator_changed)
                .unwrap()
                .modal_operator_signature
        );

        let mut dynamic_boundary_changed = plan.clone();
        dynamic_boundary_changed.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Pinned,
                boundary_pair_id: None,
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        assert_eq!(
            source,
            EquilibriumIdentitySignaturesV1::from_eigen_plan(&dynamic_boundary_changed).unwrap(),
            "dynamic spin-wave BC must not contaminate source boundary identity"
        );
        assert_ne!(
            modal.modal_dynamic_boundary_signature,
            ModalIdentitySignaturesV1::from_eigen_plan(&dynamic_boundary_changed)
                .unwrap()
                .modal_dynamic_boundary_signature
        );
    }

    #[test]
    fn equilibrium_identity_signatures_mutate_only_in_the_owning_source_family() {
        use crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1;

        let plan = minimal_native_modal_plan();
        let baseline = EquilibriumIdentitySignaturesV1::from_eigen_plan(&plan).unwrap();

        let mut material_changed = plan.clone();
        material_changed.material.saturation_magnetisation += 1.0;
        let material = EquilibriumIdentitySignaturesV1::from_eigen_plan(&material_changed).unwrap();
        assert_ne!(
            baseline.equilibrium_material_signature,
            material.equilibrium_material_signature
        );
        assert_eq!(
            baseline.equilibrium_static_physics_signature,
            material.equilibrium_static_physics_signature
        );
        assert_eq!(
            baseline.equilibrium_boundary_signature,
            material.equilibrium_boundary_signature
        );

        let mut physics_changed = plan.clone();
        physics_changed.external_field = Some([1.0, 2.0, 3.0]);
        let physics = EquilibriumIdentitySignaturesV1::from_eigen_plan(&physics_changed).unwrap();
        assert_eq!(
            baseline.equilibrium_material_signature,
            physics.equilibrium_material_signature
        );
        assert_ne!(
            baseline.equilibrium_static_physics_signature,
            physics.equilibrium_static_physics_signature
        );
        assert_eq!(
            baseline.equilibrium_boundary_signature,
            physics.equilibrium_boundary_signature
        );

        let mut boundary_changed = plan;
        boundary_changed.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 3.0,
            grading: 1.4,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("dipole".to_string()),
            robin_beta_factor: Some(2.0),
            shape: Some("bbox".to_string()),
            factor_source: Some("user".to_string()),
            boundary_marker_source: Some("user_policy".to_string()),
        });
        let boundary = EquilibriumIdentitySignaturesV1::from_eigen_plan(&boundary_changed).unwrap();
        assert_eq!(
            baseline.equilibrium_material_signature,
            boundary.equilibrium_material_signature
        );
        assert_eq!(
            baseline.equilibrium_static_physics_signature,
            boundary.equilibrium_static_physics_signature
        );
        assert_ne!(
            baseline.equilibrium_boundary_signature,
            boundary.equilibrium_boundary_signature
        );
    }

    fn certified_fields(node_count: usize) -> crate::types::CertifiedFemEquilibriumFields {
        let zeros = vec![[0.0, 0.0, 0.0]; node_count];
        crate::types::CertifiedFemEquilibriumFields::from_fields(
            zeros.clone(),
            zeros.clone(),
            zeros.clone(),
            zeros,
            vec![0.0; node_count],
        )
        .expect("certified field fixture")
    }

    fn accepted_relax_completion() -> fullmag_ir::StageCompletionIR {
        fullmag_ir::StageCompletionIR {
            status: "completed".to_string(),
            converged: true,
            reason: Some(fullmag_ir::StageStopReason::Torque),
            metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
            metric_name: Some("max_torque_apm".to_string()),
            metric_value: Some(5.0e-5),
            threshold: Some(1.0e-4),
        }
    }

    fn accepted_energy_relax_completion() -> fullmag_ir::StageCompletionIR {
        fullmag_ir::StageCompletionIR {
            status: "completed".to_string(),
            converged: true,
            reason: Some(fullmag_ir::StageStopReason::Energy),
            metric: Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
            metric_name: Some("total_energy_plateau_range_J".to_string()),
            metric_value: Some(2.5e-19),
            threshold: Some(1.0e-18),
        }
    }

    fn relax_source_plan_from_eigen(plan: &FemEigenPlanIR) -> fullmag_ir::FemPlanIR {
        fullmag_ir::FemPlanIR {
            mesh_name: plan.mesh_name.clone(),
            mesh_source: plan.mesh_source.clone(),
            mesh: plan.mesh.clone(),
            object_segments: plan.object_segments.clone(),
            mesh_parts: plan.mesh_parts.clone(),
            mesh_build_report: plan.mesh_build_report.clone(),
            domain_mesh_mode: plan.domain_mesh_mode,
            domain_frame: plan.domain_frame.clone(),
            fe_order: plan.fe_order,
            hmax: plan.hmax,
            initial_magnetization: plan.equilibrium_magnetization.clone(),
            material: plan.material.clone(),
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: plan.enable_exchange,
            enable_demag: plan.enable_demag,
            external_field: plan.external_field,
            antenna_zeeman_masks: Vec::new(),
            field_drives: Vec::new(),
            field_drive_geometry_masks: Vec::new(),
            time_stage: Default::default(),
            current_modules: Vec::new(),
            spin_transport_plans: Vec::new(),
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
            precision: plan.precision,
            exchange_bc: plan.exchange_bc,
            integrator: Some(fullmag_ir::IntegratorChoice::Heun),
            fixed_timestep: Some(1.0e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: plan.demag_realization.clone(),
            air_box_config: plan.air_box_config.clone(),
            interfacial_dmi: plan.interfacial_dmi,
            dmi_interface_normal: plan.dmi_interface_normal,
            bulk_dmi: plan.bulk_dmi,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            spin_torque_contract: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            use_consistent_mass: None,
        }
    }

    fn relax_handoff_from_completion(
        plan: &FemEigenPlanIR,
        completion: &fullmag_ir::StageCompletionIR,
    ) -> Result<AcceptedFemRelaxStageHandoff, RunError> {
        let source_plan = relax_source_plan_from_eigen(plan);
        AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &crate::types::FemMeshPayload::from(plan),
            completion,
            plan.equilibrium_magnetization.clone(),
            certified_fields(plan.mesh.nodes.len()),
        )
    }

    #[test]
    fn accepted_relax_stage_handoff_v2_preserves_torque_and_energy_certificates() {
        let plan = minimal_native_modal_plan();
        let torque_completion = accepted_relax_completion();
        let torque_handoff = relax_handoff_from_completion(&plan, &torque_completion)
            .expect("torque completion should create a typed handoff");
        assert_eq!(torque_handoff.acceptance_json()["criterion"], "torque");
        assert_eq!(
            torque_handoff.acceptance_json()["metric_kind"],
            "max_torque_apm"
        );
        assert_eq!(torque_handoff.acceptance_json()["unit"], "A/m");

        let energy_completion = accepted_energy_relax_completion();
        let energy_handoff = relax_handoff_from_completion(&plan, &energy_completion)
            .expect("energy completion should create a typed handoff");
        assert_eq!(energy_handoff.acceptance_json()["criterion"], "energy");
        assert_eq!(
            energy_handoff.acceptance_json()["metric_kind"],
            "total_energy_plateau_range_j"
        );
        assert_eq!(energy_handoff.acceptance_json()["unit"], "J");
        assert_eq!(
            energy_handoff.legacy_v2_provenance_json()["schema_version"],
            "AcceptedFemRelaxStageHandoff.v2"
        );
        assert_eq!(
            energy_handoff.legacy_v2_provenance_json()["completion"],
            serde_json::to_value(&energy_completion).unwrap()
        );
        assert_eq!(
            energy_handoff.legacy_v2_provenance_json()["acceptance"],
            energy_handoff.acceptance_json()
        );
        assert!(
            energy_handoff
                .legacy_v2_provenance_json()
                .get("certified_fields_content_sha256")
                .is_none(),
            "frozen v2 provenance must not publish v3 fields"
        );
        serde_json::from_value::<AcceptedFemRelaxStageHandoffV2Record>(
            energy_handoff.legacy_v2_provenance_json(),
        )
        .expect("emitted v2 provenance must round-trip through the frozen schema");

        let node_count = plan.mesh.nodes.len();
        let changed_certified_fields = crate::types::CertifiedFemEquilibriumFields::from_fields(
            vec![[1.0, 0.0, 0.0]; node_count],
            vec![[0.0, 1.0, 0.0]; node_count],
            vec![[0.0, 0.0, 1.0]; node_count],
            vec![[1.0, 1.0, 1.0]; node_count],
            vec![2.0; node_count],
        )
        .unwrap();
        let source_plan = relax_source_plan_from_eigen(&plan);
        let same_v2_with_v3_only_state = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &crate::types::FemMeshPayload::from(&plan),
            &energy_completion,
            plan.equilibrium_magnetization.clone(),
            changed_certified_fields,
        )
        .unwrap();
        assert_eq!(
            energy_handoff.legacy_v2_content_sha256,
            same_v2_with_v3_only_state.legacy_v2_content_sha256,
            "v3-only certified fields must not mutate the frozen v2 hash preimage"
        );
        assert_ne!(
            energy_handoff.content_sha256(),
            same_v2_with_v3_only_state.content_sha256(),
            "v3 must bind the certified static fields digest"
        );

        let mut completion_snapshot_drift = energy_completion;
        completion_snapshot_drift.metric_name = Some("energy_plateau_range_j".to_string());
        let drifted_handoff = relax_handoff_from_completion(&plan, &completion_snapshot_drift)
            .expect("a valid completion snapshot should create a typed handoff");
        assert_eq!(
            drifted_handoff.acceptance_json(),
            energy_handoff.acceptance_json()
        );
        assert_ne!(
            drifted_handoff.content_sha256(),
            energy_handoff.content_sha256(),
            "the v2 digest must include the full completion snapshot"
        );
    }

    #[test]
    fn accepted_relax_stage_handoff_v3_round_trips_and_rejects_unknown_fields() {
        let plan = minimal_native_modal_plan();
        let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();
        let value = handoff.provenance_json();

        let record = serde_json::from_value::<AcceptedFemRelaxStageHandoffV3Record>(value.clone())
            .expect("emitted v3 provenance must round-trip through the typed schema");
        assert_eq!(record, handoff.v3_record());
        assert_eq!(record.schema_version, ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3);
        assert_eq!(
            record.certified_fields_content_sha256,
            record.certified_fields.content_sha256
        );

        let mut extended = value;
        extended
            .as_object_mut()
            .unwrap()
            .insert("unexpected_tail".to_string(), serde_json::json!(true));
        let error = serde_json::from_value::<AcceptedFemRelaxStageHandoffV3Record>(extended)
            .expect_err("v3 must reject unknown fields");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn accepted_relax_stage_handoff_allows_zero_m0_on_air_nodes() {
        let mut plan = minimal_native_modal_plan();
        add_minimal_shared_domain_periodic_airbox(&mut plan);
        let topology = MeshTopology::from_ir(&plan.mesh).expect("fixture topology must be valid");
        let air_nodes = topology
            .magnetic_node_volumes
            .iter()
            .enumerate()
            .filter_map(|(node, volume)| (*volume <= 0.0).then_some(node))
            .collect::<Vec<_>>();
        assert!(!air_nodes.is_empty(), "fixture must include air-only nodes");

        let mut equilibrium = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        for node in air_nodes {
            equilibrium[node] = [0.0, 0.0, 0.0];
        }
        plan.equilibrium_magnetization = equilibrium.clone();
        let source_plan = relax_source_plan_from_eigen(&plan);
        let source_mesh = crate::types::FemMeshPayload::from(&plan);
        let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &source_mesh,
            &accepted_relax_completion(),
            equilibrium,
            certified_fields(source_mesh.nodes.len()),
        )
        .expect("air-only nodes may carry zero equilibrium magnetization");
        handoff
            .validate_target_plan(&plan)
            .expect("the exact relaxed target must accept the certified handoff");

        let magnetic_node = topology
            .magnetic_node_volumes
            .iter()
            .position(|volume| *volume > 0.0)
            .expect("fixture must include a magnetic node");
        plan.equilibrium_magnetization[magnetic_node] = [0.0, 0.0, 0.0];
        let error = handoff
            .validate_target_plan(&plan)
            .expect_err("a magnetic node still requires a unit m0 norm");
        assert!(error.message.contains("m0_norm_mismatch"));
    }

    #[test]
    fn accepted_relax_stage_handoff_rejects_source_identity_mutations_before_materialization() {
        let mut plan = minimal_native_modal_plan();
        let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();

        plan.material.saturation_magnetisation *= 1.01;
        let error = prepare_single_k_stage_continuation(&plan, &handoff).unwrap_err();
        assert!(error.message.contains("material_signature_mismatch"));

        let mut plan = minimal_native_modal_plan();
        plan.external_field = Some([1.0, 0.0, 0.0]);
        let error = prepare_single_k_stage_continuation(&plan, &handoff).unwrap_err();
        assert!(error.message.contains("static_physics_signature_mismatch"));

        let mut plan = minimal_native_modal_plan();
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.0,
            boundary_marker: 99,
            bc_kind: None,
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: None,
            factor_source: None,
            boundary_marker_source: None,
        });
        let error = prepare_single_k_stage_continuation(&plan, &handoff).unwrap_err();
        assert!(error.message.contains("boundary_signature_mismatch"));

        let mut modal_only = minimal_native_modal_plan();
        modal_only.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Pinned,
        );
        prepare_single_k_stage_continuation(&modal_only, &handoff)
            .expect("modal-only dynamic BC must not impersonate or invalidate source identity");
    }

    #[test]
    fn accepted_relax_stage_handoff_rejects_certified_field_and_m0_mutations() {
        let plan = minimal_native_modal_plan();
        let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();

        let mut digest_drift = handoff.clone();
        digest_drift.certified_fields.h_ex_a_per_m[0][0] = 1.0;
        let error = prepare_single_k_stage_continuation(&plan, &digest_drift).unwrap_err();
        assert!(error.message.contains("certified_fields_invalid"));

        let mut component_drift = handoff.clone();
        component_drift.certified_fields.h_ex_a_per_m[0][0] = 1.0;
        component_drift.certified_fields.h_eff_a_per_m[0][0] = 1.0;
        component_drift.certified_fields.content_sha256 =
            crate::types::certified_equilibrium_fields_sha256(&component_drift.certified_fields);
        let error = prepare_single_k_stage_continuation(&plan, &component_drift).unwrap_err();
        assert!(error.message.contains("content_sha256_mismatch"));

        let mut phi_drift = handoff.clone();
        phi_drift.certified_fields.phi_a[0] = 1.0;
        phi_drift.certified_fields.content_sha256 =
            crate::types::certified_equilibrium_fields_sha256(&phi_drift.certified_fields);
        let error = prepare_single_k_stage_continuation(&plan, &phi_drift).unwrap_err();
        assert!(error.message.contains("content_sha256_mismatch"));

        let mut decomposition_drift = handoff.clone();
        decomposition_drift.certified_fields.h_eff_a_per_m[0][0] = 1.0;
        decomposition_drift.certified_fields.content_sha256 =
            crate::types::certified_equilibrium_fields_sha256(
                &decomposition_drift.certified_fields,
            );
        let error = prepare_single_k_stage_continuation(&plan, &decomposition_drift).unwrap_err();
        assert!(error.message.contains("decomposition_mismatch"));

        let mut non_unit_source = relax_source_plan_from_eigen(&plan);
        non_unit_source.initial_magnetization[0] = [0.5, 0.0, 0.0];
        let error = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &non_unit_source,
            &crate::types::FemMeshPayload::from(&non_unit_source),
            &accepted_relax_completion(),
            non_unit_source.initial_magnetization.clone(),
            certified_fields(non_unit_source.mesh.nodes.len()),
        )
        .unwrap_err();
        assert!(error.message.contains("m0_norm_mismatch"));
    }

    #[test]
    fn accepted_relax_stage_handoff_revalidates_schema_completion_and_all_hash_layers() {
        let plan = minimal_native_modal_plan();
        let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();

        let mutations: Vec<(&str, Box<dyn Fn(&mut AcceptedFemRelaxStageHandoff)>, &str)> = vec![
            (
                "schema",
                Box::new(|handoff| handoff.schema_version = "unexpected".to_string()),
                "schema_version_mismatch",
            ),
            (
                "completion snapshot",
                Box::new(|handoff| handoff.completion.metric_value = Some(4.0e-5)),
                "acceptance_certificate_mismatch",
            ),
            (
                "completion digest",
                Box::new(|handoff| {
                    handoff.completion_sha256 = format!("sha256:{}", "0".repeat(64))
                }),
                "completion_sha256_mismatch",
            ),
            (
                "acceptance digest",
                Box::new(|handoff| {
                    handoff.acceptance_certificate_sha256 = format!("sha256:{}", "0".repeat(64))
                }),
                "acceptance_certificate_sha256_mismatch",
            ),
            (
                "legacy v2 digest",
                Box::new(|handoff| {
                    handoff.legacy_v2_content_sha256 = format!("sha256:{}", "0".repeat(64))
                }),
                "v2_content_sha256_mismatch",
            ),
            (
                "v3 content digest",
                Box::new(|handoff| handoff.content_sha256 = format!("sha256:{}", "0".repeat(64))),
                "content_sha256_mismatch",
            ),
        ];

        for (name, mutate, expected) in mutations {
            let mut drift = handoff.clone();
            mutate(&mut drift);
            let error = prepare_single_k_stage_continuation(&plan, &drift)
                .expect_err("integrity mutation must fail closed");
            assert!(
                error.message.contains(expected),
                "{name} returned unexpected error: {}",
                error.message
            );
        }
    }

    #[test]
    fn accepted_relax_stage_handoff_rejects_nonconvergent_and_incoherent_completions() {
        let plan = minimal_native_modal_plan();
        let rejected = [
            fullmag_ir::StageCompletionIR {
                status: "completed".to_string(),
                converged: false,
                reason: Some(fullmag_ir::StageStopReason::MaxSteps),
                metric: Some(fullmag_ir::StageMetricKind::Steps),
                metric_name: Some("steps".to_string()),
                metric_value: Some(50_000.0),
                threshold: Some(50_000.0),
            },
            fullmag_ir::StageCompletionIR {
                status: "cancelled".to_string(),
                converged: false,
                reason: Some(fullmag_ir::StageStopReason::UserCancelled),
                metric: None,
                metric_name: None,
                metric_value: None,
                threshold: None,
            },
            fullmag_ir::StageCompletionIR {
                reason: Some(fullmag_ir::StageStopReason::Torque),
                metric: Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
                ..accepted_energy_relax_completion()
            },
        ];

        for completion in rejected {
            let error = relax_handoff_from_completion(&plan, &completion)
                .expect_err("nonconvergent or incoherent completion must fail closed");
            assert!(error.message.contains("completion_not_accepted"));
        }
    }

    #[test]
    fn operator_m0_uses_a_deterministic_unit_extension_on_air_nodes() {
        let plan = minimal_native_modal_plan();
        let mut topology = MeshTopology::from_ir(&plan.mesh).unwrap();
        let air_node = topology.n_nodes - 1;
        topology.magnetic_node_volumes[air_node] = 0.0;
        let mut equilibrium = vec![[1.0, 0.0, 0.0]; topology.n_nodes];
        equilibrium[air_node] = [0.0, 0.0, 0.0];

        let extended = extend_equilibrium_m0_to_air_nodes(&topology, &equilibrium);

        assert_eq!(extended[..air_node], equilibrium[..air_node]);
        assert_eq!(extended[air_node], [0.0, 0.0, 1.0]);
    }

    #[test]
    fn relaxed_initial_state_without_handoff_fails_before_materialization() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
        // A missing topology makes any attempt to materialize/assemble visible:
        // the certification gate must win before progress or mesh access.
        plan.mesh.nodes.clear();
        plan.mesh.cells = fullmag_ir::FemConnectivityIR::empty();
        plan.equilibrium_magnetization.clear();
        let mut progress_events = 0usize;
        let mut progress = |_event: FemEigenProgress| {
            progress_events += 1;
            StepAction::Continue
        };

        let error = execute_fem_eigen_inner(
            &plan,
            &[],
            false,
            false,
            Some(&mut progress),
            0,
            None,
            None,
            None,
        )
        .expect_err("uncertified relaxed_initial_state must fail closed");

        assert!(error
            .message
            .contains("accepted relaxation handoff is required"));
        assert_eq!(progress_events, 0, "failure must precede materialization");
    }

    #[test]
    fn provided_equilibrium_without_certificate_fails_before_materialization() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::Provided;
        plan.mesh.nodes.clear();
        plan.mesh.cells = fullmag_ir::FemConnectivityIR::empty();
        plan.equilibrium_magnetization.clear();
        let mut progress_events = 0usize;
        let mut progress = |_event: FemEigenProgress| {
            progress_events += 1;
            StepAction::Continue
        };

        let error = execute_fem_eigen_inner(
            &plan,
            &[],
            false,
            false,
            Some(&mut progress),
            0,
            None,
            None,
            None,
        )
        .expect_err("uncertified provided equilibrium must fail closed");

        assert!(error.message.contains("uncertified_provided_equilibrium"));
        assert_eq!(progress_events, 0, "failure must precede materialization");
    }

    #[test]
    fn gpu_kittel_provided_equilibrium_without_certificate_fails_before_materialization() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = false;
        plan.enable_demag = false;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });
        plan.equilibrium = EquilibriumSourceIR::Provided;
        plan.mesh.nodes.clear();
        plan.mesh.cells = fullmag_ir::FemConnectivityIR::empty();
        plan.equilibrium_magnetization.clear();

        let error = execute_gpu_fem_eigen(&plan, &[], None)
            .expect_err("GPU Kittel must reject uncertified provided equilibrium");

        assert!(error.message.contains("uncertified_provided_equilibrium"));
    }

    #[test]
    fn raw_provided_fixture_requires_explicit_validation_only_adapter() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::Provided;

        let handoff = validation_only_raw_provided_fixture_handoff(&plan)
            .expect("test adapter should build a validation-only typed handoff");

        validate_eigen_equilibrium_certificate(&plan, Some(&handoff), None)
            .expect("explicit validation-only handoff should satisfy the test boundary");
        assert!(handoff.content_sha256().starts_with("sha256:"));
    }

    #[test]
    fn validation_only_raw_provided_adapter_rejects_non_provided_source() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;

        let error = validation_only_raw_provided_fixture_handoff(&plan)
            .expect_err("test adapter must not certify a production equilibrium source");

        assert_eq!(
            error.message,
            "validation_only_raw_provided_requires_provided_equilibrium"
        );
    }

    #[test]
    fn accepted_relax_stage_handoff_prepares_single_k_without_second_relaxation() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });
        let accepted_m0 = vec![[0.0, 1.0, 0.0]; plan.mesh.nodes.len()];
        plan.equilibrium_magnetization = accepted_m0.clone();
        let source_mesh = crate::types::FemMeshPayload::from(&plan);
        let source_plan = relax_source_plan_from_eigen(&plan);
        let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &source_mesh,
            &accepted_relax_completion(),
            accepted_m0.clone(),
            certified_fields(source_mesh.nodes.len()),
        )
        .expect("accepted relax completion should create a typed handoff");

        let prepared = prepare_single_k_stage_continuation(&plan, &handoff)
            .expect("same-mesh single-k target should accept the handoff");
        let (_problem, consumed_m0, relaxation_steps, _observables, _source) =
            materialize_equilibrium(&prepared, &prepared.equilibrium_magnetization, None)
                .expect("provided equilibrium should materialize without relaxation");

        assert_eq!(prepared.equilibrium, EquilibriumSourceIR::Provided);
        assert_eq!(consumed_m0, accepted_m0);
        assert_eq!(relaxation_steps, 0);
    }

    #[test]
    fn accepted_relax_stage_handoff_preserves_exact_equilibrium_after_state_normalization() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });
        let scale = 1.0 + 5.0e-9;
        let accepted_m0 = vec![[0.6 * scale, 0.8 * scale, 0.0]; plan.mesh.nodes.len()];
        plan.equilibrium_magnetization = accepted_m0.clone();
        let source_mesh = crate::types::FemMeshPayload::from(&plan);
        let source_plan = relax_source_plan_from_eigen(&plan);
        let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &source_mesh,
            &accepted_relax_completion(),
            accepted_m0.clone(),
            certified_fields(source_mesh.nodes.len()),
        )
        .expect("accepted relax completion should create a typed handoff");

        let prepared = prepare_single_k_stage_continuation(&plan, &handoff)
            .expect("same-mesh single-k target should accept the handoff");
        let (_problem, consumed_m0, _steps, _observables, _source) = materialize_equilibrium(
            &prepared,
            &prepared.equilibrium_magnetization,
            Some(&handoff),
        )
        .expect("provided continuation equilibrium should materialize without relaxation");

        assert_eq!(consumed_m0, accepted_m0);
    }

    #[test]
    fn gpu_stage_handoff_rejects_plan_outside_native_shared_domain_lane_before_progress() {
        let mut plan = minimal_native_modal_plan();
        add_minimal_shared_domain_periodic_airbox(&mut plan);
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 2.0e9,
        };
        plan.count = 33;
        let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion())
            .expect("accepted completion should create a typed handoff");
        let mut progress_event_count = 0usize;
        let mut progress = |_event: FemEigenProgress| {
            progress_event_count += 1;
            StepAction::Stop
        };

        let error = execute_gpu_fem_eigen_with_progress_and_stage_handoff(
            &plan,
            &[],
            Some(&mut progress),
            &handoff,
        )
        .expect_err("an unsupported prepared GPU plan must fail before solver execution");

        assert_eq!(
            error.message,
            "relax_to_eigen_handoff_requires_shared_domain_modal_execution"
        );
        assert_eq!(progress_event_count, 0);
    }

    #[test]
    fn equilibrium_artifact_v7_writer_preserves_stage_handoff_certificate() {
        let mut plan = minimal_native_modal_plan();
        add_minimal_shared_domain_periodic_airbox(&mut plan);
        plan.equilibrium = EquilibriumSourceIR::Provided;
        let completion = accepted_relax_completion();
        let handoff = relax_handoff_from_completion(&plan, &completion)
            .expect("accepted completion should create a certified handoff");
        let topology = MeshTopology::from_ir(&plan.mesh).unwrap();
        let material = MaterialParameters::new(
            plan.material.saturation_magnetisation,
            plan.material.exchange_stiffness,
            plan.material.damping,
        )
        .unwrap();
        let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::RK23).unwrap();
        let problem = FemLlgProblem::with_terms(
            topology.clone(),
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                external_field: plan.external_field,
                ..EffectiveFieldTerms::default()
            },
        );
        let state = problem
            .new_state(handoff.equilibrium_magnetization.clone())
            .unwrap();
        let observables = problem.observe(&state).unwrap();

        let linearization = build_shared_domain_linearization_state(
            &plan,
            &topology,
            &problem,
            None,
            Some(&handoff),
            &handoff.equilibrium_magnetization,
            &observables,
        )
        .unwrap();

        assert_eq!(
            linearization.equilibrium_artifact["acceptance_certificate"],
            serde_json::json!({
                "criterion": "torque",
                "metric_kind": "max_torque_apm",
                "metric_value": completion.metric_value.unwrap(),
                "threshold": completion.threshold.unwrap(),
                "unit": "A/m",
                "status": "completed",
                "converged": true,
                "stop_reason": "torque",
                "completion_sha256": handoff.completion_sha256,
            })
        );
    }

    #[test]
    fn accepted_relax_stage_handoff_is_fail_closed_for_completion_mesh_and_m0_drift() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });
        let accepted_m0 = plan.equilibrium_magnetization.clone();
        let source_mesh = crate::types::FemMeshPayload::from(&plan);
        let source_plan = relax_source_plan_from_eigen(&plan);

        let error = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_run",
            false,
            &source_plan,
            &source_mesh,
            &accepted_relax_completion(),
            accepted_m0.clone(),
            certified_fields(source_mesh.nodes.len()),
        )
        .expect_err("a non-relaxation source stage must not create a handoff");
        assert!(error.message.contains("invalid_source_stage"));

        let mut rejected_completion = accepted_relax_completion();
        rejected_completion.converged = false;
        let error = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &source_mesh,
            &rejected_completion,
            accepted_m0.clone(),
            certified_fields(source_mesh.nodes.len()),
        )
        .expect_err("unaccepted completion must not create a handoff");
        assert!(error.message.contains("completion_not_accepted"));

        let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &source_mesh,
            &accepted_relax_completion(),
            accepted_m0.clone(),
            certified_fields(source_mesh.nodes.len()),
        )
        .expect("accepted completion should create a handoff");

        let mut topology_drift = plan.clone();
        topology_drift.mesh.set_tet4_cells(vec![[0, 2, 1, 3]]);
        let error = prepare_single_k_stage_continuation(&topology_drift, &handoff)
            .expect_err("same node count with changed indexing must fail");
        assert!(error.message.contains("mesh_identity_mismatch"));

        let mut m0_drift = plan.clone();
        m0_drift.equilibrium_magnetization[0] = [0.0, 0.0, 1.0];
        let error = prepare_single_k_stage_continuation(&m0_drift, &handoff)
            .expect_err("changed equilibrium content must fail");
        assert!(error.message.contains("equilibrium_content_mismatch"));
    }

    #[test]
    fn accepted_relax_stage_handoff_binds_summary_and_mode_provenance() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });
        let source_mesh = crate::types::FemMeshPayload::from(&plan);
        let source_plan = relax_source_plan_from_eigen(&plan);
        let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-relax",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &source_mesh,
            &accepted_relax_completion(),
            plan.equilibrium_magnetization.clone(),
            certified_fields(source_mesh.nodes.len()),
        )
        .expect("accepted completion should create a handoff");
        let mut run = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: plan.equilibrium_magnetization.clone(),
                completion: None,
            },
            initial_magnetization: plan.equilibrium_magnetization.clone(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: vec![
                json_artifact(
                    "eigen/metadata/eigen_summary.json",
                    &serde_json::json!({
                        "equilibrium_source": "provided",
                        "relaxation_steps": 0,
                        "solver_diagnostics": {},
                        "modes": [{"index": 0}],
                    }),
                )
                .unwrap(),
                json_artifact(
                    "eigen/modes/mode_0000.json",
                    &serde_json::json!({"index": 0}),
                )
                .unwrap(),
                json_artifact(
                    "eigen/diagnostics/solver.v1.json",
                    &serde_json::json!({"solver_adapter": "test"}),
                )
                .unwrap(),
                json_artifact(
                    "eigen/spectrum.v3.json",
                    &serde_json::json!({
                        "schema_version": "eigen_spectrum.v3",
                        "samples": [{
                            "sample_index": 0,
                            "modes": [{"raw_mode_index": 0}]
                        }]
                    }),
                )
                .unwrap(),
            ],
            provenance: ExecutionProvenance::default(),
        };

        bind_stage_continuation_artifacts(&mut run, &handoff)
            .expect("accepted handoff should bind artifacts");
        let summary: serde_json::Value =
            serde_json::from_slice(&run.auxiliary_artifacts[0].bytes).unwrap();
        let mode: serde_json::Value =
            serde_json::from_slice(&run.auxiliary_artifacts[1].bytes).unwrap();
        let solver: serde_json::Value =
            serde_json::from_slice(&run.auxiliary_artifacts[2].bytes).unwrap();
        let spectrum_v3: serde_json::Value =
            serde_json::from_slice(&run.auxiliary_artifacts[3].bytes).unwrap();

        assert_eq!(
            summary["equilibrium_source"]["handoff"],
            "stage_continuation"
        );
        assert_eq!(
            summary["equilibrium_source"]["content_sha256"],
            handoff.content_sha256()
        );
        assert_eq!(
            mode["relax_to_eigen_handoff_sha256"],
            handoff.content_sha256()
        );
        assert_eq!(
            mode["source_mesh_topology_sha256"],
            handoff.source_mesh_topology_sha256
        );
        assert_eq!(
            summary["solver_diagnostics"]["source_mesh_topology_sha256"],
            handoff.source_mesh_topology_sha256
        );
        assert_eq!(
            summary["modes"][0]["relax_to_eigen_handoff_sha256"],
            handoff.content_sha256()
        );
        assert_eq!(
            summary["modes"][0]["source_mesh_topology_sha256"],
            handoff.source_mesh_topology_sha256
        );
        assert_eq!(
            solver["relax_to_eigen_handoff_sha256"],
            handoff.content_sha256()
        );
        assert_eq!(
            solver["source_mesh_topology_sha256"],
            handoff.source_mesh_topology_sha256
        );
        assert_eq!(
            spectrum_v3["samples"][0]["modes"][0]["relax_to_eigen_handoff_sha256"],
            handoff.content_sha256()
        );
        assert_eq!(
            spectrum_v3["samples"][0]["modes"][0]["source_mesh_topology_sha256"],
            handoff.source_mesh_topology_sha256
        );
        assert_eq!(
            summary["solver_diagnostics"]["relax_to_eigen_handoff"]["source_run_id"],
            "run-relax"
        );
        assert_eq!(
            summary["solver_diagnostics"]["relax_to_eigen_handoff"]["source_stage_id"],
            "stage-000"
        );
        assert_eq!(
            summary["solver_diagnostics"]["relax_to_eigen_handoff"]["source_stage_kind"],
            "flat_relax"
        );
    }

    #[test]
    fn accepted_relax_handoff_round_trips_through_summary_provenance() {
        let plan = minimal_native_modal_plan();
        let equilibrium = plan.equilibrium_magnetization.clone();
        let expected = AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
            &plan,
            equilibrium.clone(),
            format!("sha256:{}", "a".repeat(64)),
            format!("sha256:{}", "b".repeat(64)),
        )
        .expect("accepted linearization should produce a handoff");
        let diagnostics = serde_json::json!({
            "source_mesh_topology_sha256": expected.source_mesh_topology_sha256(),
            "relax_to_eigen_handoff_sha256": expected.content_sha256(),
            "equilibrium_artifact_sha256": expected.equilibrium_artifact_sha256,
            "linearization_state_sha256": expected.linearization_state_sha256,
            "relax_to_eigen_handoff": expected.provenance_json(),
        });
        let run = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: equilibrium,
                completion: None,
            },
            initial_magnetization: Vec::new(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: vec![json_artifact(
                "eigen/metadata/eigen_summary.json",
                &serde_json::json!({"solver_diagnostics": diagnostics}),
            )
            .expect("summary fixture should serialize")],
            provenance: ExecutionProvenance::default(),
        };

        let restored = accepted_relax_to_eigen_handoff_from_run(&plan, &run)
            .expect("summary provenance should restore the exact handoff");

        assert_eq!(restored.content_sha256(), expected.content_sha256());
        assert_eq!(
            restored.source_mesh_topology_sha256(),
            expected.source_mesh_topology_sha256()
        );
    }

    #[test]
    fn native_modal_progress_json_maps_to_runtime_progress() {
        let event = native_modal_progress_event(
            r#"{"schema_version":"fem_frequency_domain_progress.v1","solver_phase":"solving_shift_invert","candidate_mode_count":4,"accepted_mode_count":2,"outer_iteration":7,"max_outer_iterations":300,"linear_iteration":11,"current_residual_relative_l2":1.25e-9}"#,
            NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            12,
            24,
            3,
        )
        .expect("valid native progress should map");
        assert_eq!(event.phase, "solving_native_shift_invert");
        assert_eq!(event.candidate_modes, 4);
        assert_eq!(event.computed_modes, 2);
        assert_eq!(event.iteration, Some(7));
        assert_eq!(event.max_iterations, Some(300));
        assert_eq!(event.residual, Some(1.25e-9));
        assert!(native_modal_progress_event("not-json", "solver", 1, 2, 1).is_none());
    }

    #[test]
    fn bias_field_sweep_relax_each_always_starts_from_plan_initial_state() {
        let mut plan = minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::Provided;
        let base_initial = plan.equilibrium_magnetization.clone();
        let previous = vec![[0.0, 1.0, 0.0]; base_initial.len()];
        let sample = bias_field_sample(
            0,
            [20_000.0, 0.0, 0.0],
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
        );

        let prepared =
            prepare_bias_field_sample_plan(&plan, &sample, &base_initial, Some(&previous))
                .expect("relax_each sample should prepare without a native solve");

        assert_eq!(prepared.external_field, Some(sample.field_a_per_m));
        assert_eq!(
            prepared.equilibrium,
            EquilibriumSourceIR::RelaxedInitialState
        );
        assert_eq!(prepared.equilibrium_magnetization, base_initial);
    }

    #[test]
    fn bias_field_sweep_continuation_uses_previous_accepted_equilibrium() {
        let plan = minimal_native_modal_plan();
        let base_initial = plan.equilibrium_magnetization.clone();
        let previous = vec![[0.0, 1.0, 0.0]; base_initial.len()];
        let sample = bias_field_sample(
            1,
            [40_000.0, 0.0, 0.0],
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
        );

        let prepared =
            prepare_bias_field_sample_plan(&plan, &sample, &base_initial, Some(&previous))
                .expect("continuation sample should prepare without a native solve");

        assert_eq!(
            prepared.equilibrium,
            EquilibriumSourceIR::RelaxedInitialState
        );
        assert_eq!(prepared.equilibrium_magnetization, previous);
    }

    #[test]
    fn bias_field_sweep_continuation_initial_state_bootstraps_from_plan_initial() {
        let plan = minimal_native_modal_plan();
        let base_initial = plan.equilibrium_magnetization.clone();
        let sample = bias_field_sample(
            0,
            [20_000.0, 0.0, 0.0],
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
        );

        let prepared = prepare_bias_field_sample_plan(&plan, &sample, &base_initial, None)
            .expect("initial-state continuation should prepare without a native solve");

        assert_eq!(
            prepared.equilibrium,
            EquilibriumSourceIR::RelaxedInitialState
        );
        assert_eq!(prepared.equilibrium_magnetization, base_initial);
    }

    #[test]
    fn bias_field_sweep_accepts_finite_zero_field_sample() {
        let mut plan = minimal_native_modal_plan();
        plan.bias_field_samples = vec![bias_field_sample(
            0,
            [0.0, 0.0, 0.0],
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
        )];

        let samples = validate_bias_field_samples(&plan)
            .expect("a finite zero bias field is a legal physical sample");
        assert_eq!(samples[0].field_a_per_m, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn bias_field_sweep_rejects_relax_each_with_previous_seed() {
        let mut plan = minimal_native_modal_plan();
        plan.bias_field_samples = vec![bias_field_sample(
            0,
            [20_000.0, 0.0, 0.0],
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
        )];

        let error = validate_bias_field_samples(&plan)
            .expect_err("relax_each must not silently ignore continuation seed");
        assert!(error.message.contains("use initial_state"));
    }

    #[test]
    fn bias_field_sweep_stops_before_merge_on_cancelled_sample() {
        assert!(!bias_field_sample_is_complete(RunStatus::Cancelled));
        assert!(!bias_field_sample_is_complete(RunStatus::Paused));
        assert!(bias_field_sample_is_complete(RunStatus::Completed));
    }

    #[test]
    fn cancelled_bias_field_sample_preserves_interrupted_partial_artifact() {
        let run = ExecutedRun {
            result: RunResult {
                status: RunStatus::Cancelled,
                steps: Vec::new(),
                final_magnetization: Vec::new(),
                completion: None,
            },
            initial_magnetization: Vec::new(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: vec![
                json_artifact(
                    "eigen/partial.v1.json",
                    &serde_json::json!({
                        "schema_version": "fem_k0_modal_partial.v1",
                        "complete": false,
                    }),
                )
                .expect("partial artifact fixture should serialize"),
                json_artifact(
                    "eigen/spectrum.v2.json",
                    &serde_json::json!({
                        "schema_version": "eigen_spectrum.v2",
                        "complete": true,
                        "samples": []
                    }),
                )
                .expect("spectrum artifact fixture should serialize"),
            ],
            provenance: ExecutionProvenance::default(),
        };

        let preserved = preserve_interrupted_bias_field_sweep_run(
            run,
            3,
            1,
            1,
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
        )
        .expect("cancelled sample should preserve a partial artifact");
        let partial = preserved
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/partial.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("preserved partial artifact should be valid JSON");
        assert_eq!(partial["status"], "interrupted");
        assert_eq!(partial["complete"], false);
        assert_eq!(partial["field_sweep"]["requested_sample_count"], 3);
        assert_eq!(partial["field_sweep"]["completed_sample_count"], 1);
        assert_eq!(partial["field_sweep"]["interrupted_sample_index"], 1);
        assert_eq!(
            partial["field_sweep"]["continuation_seed"],
            "previous_accepted_equilibrium"
        );
        let spectrum = preserved
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/spectrum.v2.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("spectrum artifact should remain valid JSON");
        assert_eq!(spectrum["status"], "interrupted");
        assert_eq!(spectrum["complete"], false);
        assert_eq!(preserved.result.status, RunStatus::Cancelled);
    }

    fn bias_field_sweep_run_fixture(sample_index: usize, status: RunStatus) -> ExecutedRun {
        let mode_field_id = format!("analysis:eigen:sample-{sample_index:04}:mode-0000");
        let mode_field_resource_key =
            format!("/v2/sessions/current/data/fields/{mode_field_id}/samples/vector");
        let spectrum_mode = serde_json::json!({
            "raw_mode_index": 0,
            "frequency_hz": 1.0e9 + sample_index as f64,
            "angular_frequency_rad_per_s": std::f64::consts::TAU * (1.0e9 + sample_index as f64),
            "mode_field_id": mode_field_id,
            "mode_field_resource_key": mode_field_resource_key,
            "residual_relative_l2": 1.0e-10,
            "equilibrium_artifact_sha256": format!("sha256:{}", "a".repeat(64)),
            "linearization_state_sha256": format!("sha256:{}", "b".repeat(64)),
            "operator_input_signature_sha256": format!("sha256:{}", "c".repeat(64)),
        });
        let spectrum = serde_json::json!({
            "schema_version": "eigen_spectrum.v2",
            "samples": [{
                "sample_index": sample_index,
                "external_field_a_per_m": [20_000.0 * (sample_index + 1) as f64, 0.0, 0.0],
                "mesh_id": "mesh:test",
                "topology_revision": "mesh-rev:test",
                "modes": [spectrum_mode.clone()],
            }],
        });
        let branches = serde_json::json!({
            "schema_version": "eigen_branches.v2",
            "branches": [{
                "branch_id": 0,
                "points": [{"sample_index": sample_index, "raw_mode_index": 0}],
            }],
        });
        let diagnostics = serde_json::json!({
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "requested_execution": {"backend": "fem", "device": "cpu"},
            "resolved_execution": {"backend": "fem", "device": "cpu"},
        });
        let summary = serde_json::json!({
            "solver_kind": "k0_poisson_airbox_cpu_schur_slepc",
            "modes": [spectrum_mode],
            "solver_diagnostics": diagnostics,
        });
        let manifest = serde_json::json!({
            "schema_version": "frequency_domain_manifest.v1",
            "artifacts": {},
            "resources": {},
        });
        let mut auxiliary_artifacts = vec![
            json_artifact("eigen/spectrum.v2.json", &spectrum).unwrap(),
            json_artifact("eigen/branches.v2.json", &branches).unwrap(),
            json_artifact("eigen/metadata/eigen_summary.json", &summary).unwrap(),
            json_artifact("eigen/diagnostics/solver.v1.json", &diagnostics).unwrap(),
            json_artifact("frequency_domain/manifest.v1.json", &manifest).unwrap(),
            json_artifact(
                format!("eigen/modes/sample_{sample_index:04}/mode_0000.json"),
                &serde_json::json!({
                    "mode_field_id": mode_field_id,
                    "mode_field_resource_key": mode_field_resource_key,
                }),
            )
            .unwrap(),
            AuxiliaryArtifact {
                relative_path: format!(
                    "eigen/mode_fields.zarr/sample_{sample_index:04}/mode_0000/real.bin"
                ),
                bytes: vec![0, 1, 2, 3],
            },
        ];
        if status != RunStatus::Completed {
            auxiliary_artifacts.push(
                json_artifact(
                    "eigen/partial.v1.json",
                    &serde_json::json!({"status": run_status_label(status), "complete": false}),
                )
                .unwrap(),
            );
        }
        ExecutedRun {
            result: RunResult {
                status,
                steps: Vec::new(),
                final_magnetization: Vec::new(),
                completion: None,
            },
            initial_magnetization: Vec::new(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts,
            provenance: ExecutionProvenance::default(),
        }
    }

    #[test]
    fn terminal_bias_field_sweep_publishes_only_completed_prefix_with_exact_lifecycle() {
        for (terminal_status, artifact_status, stop_reason, interrupted) in [
            (
                RunStatus::Cancelled,
                "interrupted",
                "cancel_requested",
                true,
            ),
            (RunStatus::Paused, "interrupted", "pause_requested", true),
            (RunStatus::Failed, "corrupt", "failed", false),
        ] {
            let merged = merge_bias_field_sweep_runs(
                vec![
                    bias_field_sweep_run_fixture(0, RunStatus::Completed),
                    bias_field_sweep_run_fixture(1, terminal_status),
                ],
                3,
                fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
                fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
            )
            .expect("terminal sweep should publish a typed partial result");
            let typed = merged
                .auxiliary_artifacts
                .iter()
                .find(|artifact| artifact.relative_path == "eigen/field_sweep.v1.json")
                .and_then(|artifact| {
                    serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok()
                })
                .expect("typed field sweep must always be discoverable");
            assert_eq!(typed["status"], artifact_status);
            assert_eq!(typed["complete"], false);
            assert_eq!(typed["interrupted"], interrupted);
            assert_eq!(typed["stop_reason"], stop_reason);
            assert_eq!(typed["requested_sample_count"], 3);
            assert_eq!(typed["completed_sample_count"], 1);
            assert_eq!(typed["samples"].as_array().map(Vec::len), Some(1));
            assert_eq!(typed["samples"][0]["status"], "complete");
            assert_eq!(typed["samples"][0]["modes"][0]["status"], "complete");
            assert!(typed.get("promotion").is_none());
            assert!(typed.get("promotion_binding").is_none());
            assert!(!merged.auxiliary_artifacts.iter().any(|artifact| {
                artifact
                    .relative_path
                    .starts_with("eigen/modes/sample_0001/")
            }));
            assert!(!merged.auxiliary_artifacts.iter().any(|artifact| {
                artifact
                    .relative_path
                    .starts_with("eigen/mode_fields.zarr/sample_0001/")
            }));
            let manifest = merged
                .auxiliary_artifacts
                .iter()
                .find(|artifact| artifact.relative_path == "frequency_domain/manifest.v1.json")
                .and_then(|artifact| {
                    serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok()
                })
                .expect("typed field sweep discovery manifest must be valid");
            assert_eq!(
                manifest["artifacts"]["field_sweep_v1_path"],
                "eigen/field_sweep.v1.json"
            );
            assert_eq!(
                manifest["resources"]["field_sweep_resource_key"],
                "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep.v1"
            );
        }
    }

    #[test]
    fn failed_bias_field_sweep_finalizer_publishes_completed_prefix_without_terminal_sample() {
        let failure_reason =
            "native FEM modal_eigen production CPU solve failed: injected sample failure";
        let finalized = finalize_failed_bias_field_sweep(
            vec![bias_field_sweep_run_fixture(0, RunStatus::Completed)],
            3,
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
            RunError {
                message: failure_reason.to_string(),
            },
        )
        .expect("a failed later sample should publish the completed prefix");

        assert_eq!(finalized.result.status, RunStatus::Failed);
        let completion = finalized
            .result
            .completion
            .as_ref()
            .expect("failed sweep must expose terminal stage lifecycle");
        assert_eq!(completion.status, "failed");
        assert_eq!(
            completion.reason,
            Some(fullmag_ir::StageStopReason::BackendError)
        );
        let typed = finalized
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/field_sweep.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("failed sweep must publish a typed field-sweep artifact");
        assert_eq!(typed["status"], "corrupt");
        assert_eq!(typed["complete"], false);
        assert_eq!(typed["interrupted"], false);
        assert_eq!(typed["stop_reason"], failure_reason);
        assert_eq!(typed["requested_sample_count"], 3);
        assert_eq!(typed["completed_sample_count"], 1);
        assert_eq!(typed["samples"].as_array().map(Vec::len), Some(1));
        assert_eq!(typed["samples"][0]["sample_index"], 0);
        assert!(!finalized.auxiliary_artifacts.iter().any(|artifact| {
            artifact
                .relative_path
                .starts_with("eigen/modes/sample_0001/")
        }));

        let diagnostics = finalized
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/diagnostics/solver.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("failed sweep must preserve typed solver diagnostics");
        assert_eq!(diagnostics["status"], "corrupt");
        assert_eq!(diagnostics["field_sweep"]["run_status"], "failed");
        assert_eq!(diagnostics["field_sweep"]["stop_reason"], failure_reason);
    }

    #[test]
    fn bias_field_sweep_executor_error_finalizes_completed_prefix_without_terminal_sample() {
        let mut plan = minimal_native_modal_plan();
        plan.bias_field_samples = (0..3)
            .map(|sample_index| {
                bias_field_sample(
                    sample_index,
                    [20_000.0 * f64::from(sample_index + 1), 0.0, 0.0],
                    fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
                    fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
                )
            })
            .collect();
        let failure_reason =
            "native FEM modal_eigen production CPU solve failed: injected sample failure";
        let mut executor_entry_count = 0;
        let finalized =
            execute_bias_field_sweep_with_executor(&plan, |sample_plan, sample_position| {
                executor_entry_count += 1;
                assert_eq!(
                    sample_plan.external_field,
                    Some(plan.bias_field_samples[sample_position].field_a_per_m)
                );
                if sample_position == 0 {
                    let mut completed = bias_field_sweep_run_fixture(0, RunStatus::Completed);
                    completed.initial_magnetization = sample_plan.equilibrium_magnetization.clone();
                    completed.result.final_magnetization =
                        sample_plan.equilibrium_magnetization.clone();
                    return Ok(completed);
                }
                assert_eq!(
                    sample_position, 1,
                    "no sample may execute after the failure"
                );
                Err(RunError {
                    message: failure_reason.to_string(),
                })
            })
            .expect("a later executor error should publish the completed prefix");

        assert_eq!(executor_entry_count, 2);
        assert_eq!(finalized.result.status, RunStatus::Failed);
        let completion = finalized
            .result
            .completion
            .as_ref()
            .expect("failed sweep must expose terminal stage lifecycle");
        assert_eq!(completion.status, "failed");
        assert_eq!(
            completion.reason,
            Some(fullmag_ir::StageStopReason::BackendError)
        );

        let typed = finalized
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/field_sweep.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("failed sweep must publish a typed field-sweep artifact");
        assert_eq!(typed["status"], "corrupt");
        assert_eq!(typed["complete"], false);
        assert_eq!(typed["interrupted"], false);
        assert_eq!(typed["stop_reason"], failure_reason);
        assert_eq!(typed["requested_sample_count"], 3);
        assert_eq!(typed["completed_sample_count"], 1);
        assert_eq!(typed["samples"].as_array().map(Vec::len), Some(1));
        assert_eq!(typed["samples"][0]["sample_index"], 0);
        assert_eq!(typed["samples"][0]["status"], "complete");
        assert_eq!(typed["samples"][0]["modes"][0]["status"], "complete");
        assert_eq!(typed["revision"], typed["content_sha256"]);
        assert_eq!(
            native_field_sweep_content_digest(&typed)
                .expect("typed field sweep self-digest must be reproducible"),
            typed["content_sha256"]
                .as_str()
                .expect("typed field sweep digest must be a string")
        );
        assert!(!finalized.auxiliary_artifacts.iter().any(|artifact| {
            artifact
                .relative_path
                .starts_with("eigen/modes/sample_0001/")
        }));
        assert!(!finalized.auxiliary_artifacts.iter().any(|artifact| {
            artifact
                .relative_path
                .starts_with("eigen/mode_fields.zarr/sample_0001/")
        }));

        let diagnostics = finalized
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/diagnostics/solver.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("failed sweep must preserve typed solver diagnostics");
        assert_eq!(diagnostics["status"], "corrupt");
        assert_eq!(diagnostics["field_sweep"]["run_status"], "failed");
        assert_eq!(diagnostics["field_sweep"]["stop_reason"], failure_reason);

        let manifest = finalized
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "frequency_domain/manifest.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("typed field sweep discovery manifest must be valid");
        assert_eq!(
            manifest["artifacts"]["field_sweep_v1_path"],
            "eigen/field_sweep.v1.json"
        );
        assert_eq!(
            manifest["resources"]["field_sweep_resource_key"],
            "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep.v1"
        );
    }

    #[test]
    fn bias_field_sweep_kittel_oracle_request_fails_closed() {
        let mut plan = minimal_native_modal_plan();
        plan.bias_field_samples = vec![bias_field_sample(
            0,
            [20_000.0, 0.0, 0.0],
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
        )];
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20_000.0, 0.0, 0.0],
            }],
        });

        let error = validate_bias_field_sweep_oracle_contract(&plan)
            .expect_err("unimplemented Kittel postsolve must fail closed");
        assert!(error
            .message
            .contains("bias_field_sweep_kittel_postsolve_oracle_unavailable"));
    }

    fn bias_field_sample(
        sample_index: u32,
        field_a_per_m: [f64; 3],
        equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
        continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
    ) -> fullmag_ir::FemEigenBiasFieldSamplePlanIR {
        fullmag_ir::FemEigenBiasFieldSamplePlanIR {
            sample_index,
            field_a_per_m,
            equilibrium_policy,
            continuation_seed,
            execution: fullmag_ir::FemEigenExecutionResolutionIR {
                requested_device: fullmag_ir::ExecutionDevice::Cpu,
                resolved_device: fullmag_ir::ExecutionDevice::Cpu,
                requested_precision: fullmag_ir::ExecutionPrecision::Double,
                resolved_precision: fullmag_ir::ExecutionPrecision::Double,
                requested_engine: fullmag_ir::FemEigenEngineIR::Auto,
                resolved_engine: fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
                fallback_used: false,
                fallback_reason: None,
                selection_reason: "test.bias_field_sweep.cpu".to_string(),
            },
        }
    }

    #[test]
    fn validation_oracle_full_interleaved_modal_a_qq_csr_preserves_scaled_entries() {
        let block_matrix = DMatrix::from_row_slice(2, 2, &[1.0e-21, -2.0e-21, 3.0e-21, -4.0e-21]);

        let (row_offsets, columns, values) =
            validation_oracle_full_interleaved_modal_a_qq_csr(&block_matrix, &[0], 1, 1.0).unwrap();

        assert_eq!(row_offsets, vec![0, 2, 4]);
        assert_eq!(columns, vec![0, 1, 0, 1]);
        assert_eq!(values, vec![1.0e-21, -2.0e-21, 3.0e-21, -4.0e-21]);
    }

    #[test]
    fn modal_certificate_map_binding_rejects_tampered_class_map() {
        let plan = minimal_native_modal_plan();
        let topology = MeshTopology::from_ir(&plan.mesh).expect("minimal FEM mesh is valid");
        let (scalar, scalar_count, magnetic, magnetic_count) =
            modal_shared_domain_equivalence_classes(&topology).expect("maps should build");
        let certificate = fullmag_ir::PeriodicMeshCertificateV6IR {
            schema_version: "periodic_mesh_certificate.v6".to_string(),
            certificate_status: "accepted".to_string(),
            topology_fingerprint: plan.mesh.topology_fingerprint_v6(),
            axis_pairs: Vec::new(),
            magnetic_class_count: scalar_count,
            magnetic_pair_count: 0,
            scalar_class_count: scalar_count,
            scalar_pair_count: 0,
            magnetic_equivalence_classes_sha256: "sha256:magnetic".to_string(),
            scalar_equivalence_classes_sha256: "sha256:scalar".to_string(),
            translation_residual_max_m: 0.0,
            orientation_residual_max: 0.0,
            normal_mismatch_max: 0.0,
            boundary_topology_match: true,
            fe_order_match: true,
            material_region_match: true,
            corner_edge_cycle_unique: true,
            edge_class_count: 0,
            corner_class_count: 0,
            max_commutation_residual_m: 0.0,
            m0_seam_mismatch_max: 0.0,
            h_demag0_seam_mismatch_max: 0.0,
            marker_map_fingerprint: "sha256:markers".to_string(),
            material_realization_fingerprint: "sha256:materials".to_string(),
            region_class_count: 0,
            max_material_residual: 0.0,
        };
        let (_, binding_digest) = build_modal_certificate_map_binding(
            &plan,
            &topology,
            &certificate,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
        )
        .expect("accepted certificate and maps should bind");
        assert!(binding_digest.starts_with("sha256:"));

        let mut tampered_scalar = scalar.clone();
        tampered_scalar[0] = tampered_scalar[0].saturating_add(1);
        let error = build_modal_certificate_map_binding(
            &plan,
            &topology,
            &certificate,
            &tampered_scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
        )
        .expect_err("a class-map mutation must fail closed before native allocation");
        assert!(error
            .message
            .contains("periodic_mesh_certificate_equivalence_map_binding_map_mismatch"));
    }

    fn modal_v6_xy_shared_domain_mesh() -> fullmag_ir::MeshIR {
        let magnetic_nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            [1.0, 1.0, 1.0],
        ];
        let mut nodes = magnetic_nodes.clone();
        nodes.extend(
            magnetic_nodes
                .iter()
                .map(|node| [node[0] + 2.0, node[1], node[2]]),
        );
        let cube_cells = vec![
            [0, 1, 3, 7],
            [0, 3, 2, 7],
            [0, 2, 6, 7],
            [0, 6, 4, 7],
            [0, 4, 5, 7],
            [0, 5, 1, 7],
        ];
        let mut cells = cube_cells.clone();
        cells.extend(
            cube_cells
                .iter()
                .map(|cell| [cell[0] + 8, cell[1] + 8, cell[2] + 8, cell[3] + 8]),
        );
        let mut periodic_node_pairs = Vec::new();
        for offset in [0_u32, 8] {
            for (node_a, node_b) in [(0, 1), (2, 3), (4, 5), (6, 7)] {
                periodic_node_pairs.push(fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: node_a + offset,
                    node_b: node_b + offset,
                });
            }
            for (node_a, node_b) in [(0, 2), (1, 3), (4, 6), (5, 7)] {
                periodic_node_pairs.push(fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "y_faces".to_string(),
                    node_a: node_a + offset,
                    node_b: node_b + offset,
                });
            }
        }
        let boundary_faces = [
            [0, 6, 2],
            [0, 4, 6],
            [1, 3, 7],
            [1, 7, 5],
            [0, 1, 5],
            [0, 5, 4],
            [2, 7, 3],
            [2, 6, 7],
        ];
        let mut facets = boundary_faces.to_vec();
        facets.extend(boundary_faces.iter().map(|face| face.map(|node| node + 8)));
        fullmag_ir::MeshIR {
            mesh_name: "modal-v6-xy-open-z".to_string(),
            nodes,
            cells: fullmag_ir::FemConnectivityIR::from_tet4(cells),
            element_markers: vec![1; 6].into_iter().chain(vec![0; 6]).collect(),
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(facets),
            boundary_markers: vec![10, 10, 11, 11, 12, 12, 13, 13]
                .into_iter()
                .chain(vec![10, 10, 11, 11, 12, 12, 13, 13])
                .collect(),
            periodic_boundary_pairs: vec![
                fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 10,
                    marker_b: 11,
                    translation: Some([1.0, 0.0, 0.0]),
                    tolerance: Some(1.0e-12),
                    axis_hint: Some("x".to_string()),
                    orientation: None,
                    pairing_policy: None,
                },
                fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "y_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 12,
                    marker_b: 13,
                    translation: Some([0.0, 1.0, 0.0]),
                    tolerance: Some(1.0e-12),
                    axis_hint: Some("y".to_string()),
                    orientation: None,
                    pairing_policy: None,
                },
            ],
            periodic_node_pairs,
            per_domain_quality: std::collections::HashMap::new(),
        }
    }

    fn accepted_modal_v6_certificate(
        mesh: &fullmag_ir::MeshIR,
    ) -> fullmag_ir::PeriodicMeshCertificateV6IR {
        mesh.periodic_mesh_certificate_v6()
            .expect("fixture must carry authoritative v6 face evidence")
    }

    fn modal_v6_xy_mesh_parts() -> Vec<fullmag_ir::FemMeshPartIR> {
        vec![
            fullmag_ir::FemMeshPartIR {
                id: "part:film".to_string(),
                label: "Film".to_string(),
                role: fullmag_ir::FemMeshPartRole::MagneticObject,
                object_id: Some("film".to_string()),
                geometry_id: Some("film".to_string()),
                material_id: None,
                element_selector: fullmag_ir::FemMeshPartSelector::ElementRange {
                    start: 0,
                    count: 6,
                },
                boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 8,
                },
                node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 8 },
                boundary_face_indices: Vec::new(),
                node_indices: (0..8).collect(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
            fullmag_ir::FemMeshPartIR {
                id: "part:__air__".to_string(),
                label: "Airbox".to_string(),
                role: fullmag_ir::FemMeshPartRole::Air,
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_selector: fullmag_ir::FemMeshPartSelector::ElementRange {
                    start: 6,
                    count: 6,
                },
                boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                    start: 8,
                    count: 8,
                },
                node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 8, count: 8 },
                boundary_face_indices: Vec::new(),
                node_indices: (8..16).collect(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
        ]
    }

    fn modal_v6_multi_part_mesh_and_parts() -> (fullmag_ir::MeshIR, Vec<fullmag_ir::FemMeshPartIR>)
    {
        let original = modal_v6_xy_shared_domain_mesh();
        let mut nodes = original.nodes[..8].to_vec();
        nodes.extend([[0.2, 0.0, 0.0], [0.0, 0.2, 0.0], [0.0, 0.0, 0.2]]);
        nodes.extend(original.nodes[8..].iter().copied());

        let original_cells = original
            .require_tet4_elements()
            .expect("base fixture must be tet4");
        let mut cells = original_cells[..6].to_vec();
        cells.push([0, 8, 9, 10]);
        cells.extend(
            original_cells[6..]
                .iter()
                .map(|cell| cell.map(|node| node + 3)),
        );

        let original_facets = original
            .require_tri3_boundary_faces()
            .expect("base fixture facets must be tri3");
        let mut facets = original_facets[..8].to_vec();
        facets.push([0, 8, 9]);
        facets.extend(
            original_facets[8..]
                .iter()
                .map(|face| face.map(|node| node + 3)),
        );

        let mesh = fullmag_ir::MeshIR {
            mesh_name: "modal-v6-multi-part-xy-open-z".to_string(),
            nodes,
            cells: fullmag_ir::FemConnectivityIR::from_tet4(cells),
            element_markers: vec![1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(facets),
            boundary_markers: vec![10, 10, 11, 11, 12, 12, 13, 13, 30]
                .into_iter()
                .chain([10, 10, 11, 11, 12, 12, 13, 13])
                .collect(),
            periodic_boundary_pairs: original.periodic_boundary_pairs,
            periodic_node_pairs: original
                .periodic_node_pairs
                .into_iter()
                .map(|mut pair| {
                    if pair.node_a >= 8 {
                        pair.node_a += 3;
                    }
                    if pair.node_b >= 8 {
                        pair.node_b += 3;
                    }
                    pair
                })
                .collect(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let parts = vec![
            fullmag_ir::FemMeshPartIR {
                id: "part:body".to_string(),
                label: "Body".to_string(),
                role: fullmag_ir::FemMeshPartRole::MagneticObject,
                object_id: Some("body".to_string()),
                geometry_id: Some("body".to_string()),
                material_id: None,
                element_selector: fullmag_ir::FemMeshPartSelector::ElementRange {
                    start: 0,
                    count: 6,
                },
                boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 8,
                },
                node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 8 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
            fullmag_ir::FemMeshPartIR {
                id: "part:hole_transition_refinement".to_string(),
                label: "Hole transition refinement".to_string(),
                role: fullmag_ir::FemMeshPartRole::MagneticObject,
                object_id: Some("body".to_string()),
                geometry_id: Some("hole_transition_refinement".to_string()),
                material_id: None,
                element_selector: fullmag_ir::FemMeshPartSelector::ElementRange {
                    start: 6,
                    count: 1,
                },
                boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                    start: 8,
                    count: 1,
                },
                node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 8, count: 3 },
                boundary_face_indices: Vec::new(),
                node_indices: vec![0, 8, 9, 10],
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
            fullmag_ir::FemMeshPartIR {
                id: "part:__air__".to_string(),
                label: "Airbox".to_string(),
                role: fullmag_ir::FemMeshPartRole::Air,
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_selector: fullmag_ir::FemMeshPartSelector::ElementRange {
                    start: 7,
                    count: 6,
                },
                boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                    start: 9,
                    count: 8,
                },
                node_selector: fullmag_ir::FemMeshPartSelector::NodeRange {
                    start: 11,
                    count: 8,
                },
                boundary_face_indices: Vec::new(),
                node_indices: (11..19).collect(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
        ];
        (mesh, parts)
    }

    fn assert_modal_v6_part_registry_error(
        mesh: &fullmag_ir::MeshIR,
        parts: &[fullmag_ir::FemMeshPartIR],
        reason: &str,
    ) {
        let error = modal_v6_part_identities(mesh, parts, 11)
            .expect_err("mutated part registry must fail closed");
        assert!(
            error.message.contains(reason),
            "expected {reason:?}, got {:?}",
            error.message
        );
    }

    #[test]
    fn modal_v6_multi_part_same_object_registry_is_accepted_and_ordered() {
        let (mesh, parts) = modal_v6_multi_part_mesh_and_parts();
        let certificate = accepted_modal_v6_certificate(&mesh);
        let (magnetic, air) = modal_v6_part_identities(&mesh, &parts, 11)
            .expect("ordered segments of one physical object must be accepted");
        assert_eq!(
            magnetic,
            "magnetic:object-id=4:body;part-count=2;part[0]-id=9:part:body;part[0]-marker=1;part[1]-id=31:part:hole_transition_refinement;part[1]-marker=2"
        );
        assert_eq!(air, "airbox:part-id=12:part:__air__");

        let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
        let (scalar, scalar_count, magnetic, magnetic_count) =
            modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
        let binding = build_owned_modal_certificate_v6_binding(
            &mesh,
            &certificate,
            &parts,
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            7,
            &[20_000.0, 0.0, 0.0],
        )
        .expect("complete multi-part producer must validate");
        assert_eq!(binding.mesh_magnetic.node_count(), 11);
        assert_eq!(binding.mesh_scalar.node_count(), 19);
        assert_eq!(&binding.mesh_scalar.region_ids[..11], &[1; 11]);
        assert_eq!(&binding.mesh_scalar.region_ids[11..], &[0; 8]);
        assert_eq!(
            binding.cell_markers,
            vec![1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
            "the native operator marker map must encode magnetic/air roles, not geometry part ids"
        );
        binding
            .validate()
            .expect("owned producer must self-validate");
    }

    #[test]
    fn modal_v6_multi_part_registry_rejects_foreign_order_duplicate_overlap_and_gaps() {
        let (mesh, parts) = modal_v6_multi_part_mesh_and_parts();

        let mut foreign_object = parts.clone();
        foreign_object[1].object_id = Some("other".to_string());
        assert_modal_v6_part_registry_error(
            &mesh,
            &foreign_object,
            "multiple_magnetic_objects_unsupported",
        );

        let mut swapped = parts.clone();
        swapped.swap(0, 1);
        assert_modal_v6_part_registry_error(&mesh, &swapped, "magnetic_part_order_noncanonical");

        let mut duplicate_id = parts.clone();
        duplicate_id[1].id = duplicate_id[0].id.clone();
        assert_modal_v6_part_registry_error(&mesh, &duplicate_id, "mesh_part_id_duplicate");

        let mut swapped_markers = mesh.clone();
        swapped_markers.element_markers[..6].fill(2);
        swapped_markers.element_markers[6] = 1;
        assert_modal_v6_part_registry_error(
            &swapped_markers,
            &parts,
            "magnetic_marker_order_noncanonical",
        );

        let mut overlap = parts.clone();
        overlap[1].element_selector =
            fullmag_ir::FemMeshPartSelector::ElementMarkerSet { markers: vec![1] };
        assert_modal_v6_part_registry_error(&mesh, &overlap, "mesh_part_element_overlap");

        let mut missing_marker = parts.clone();
        missing_marker.remove(1);
        assert_modal_v6_part_registry_error(&mesh, &missing_marker, "magnetic_marker_uncovered");

        let mut marker_zero = parts.clone();
        marker_zero[1].element_selector =
            fullmag_ir::FemMeshPartSelector::ElementRange { start: 7, count: 6 };
        assert_modal_v6_part_registry_error(
            &mesh,
            &marker_zero,
            "magnetic_part_selects_air_marker",
        );

        let mut duplicate_marker = parts;
        duplicate_marker[0].element_selector =
            fullmag_ir::FemMeshPartSelector::ElementRange { start: 0, count: 1 };
        duplicate_marker[0].node_selector =
            fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 1 };
        duplicate_marker[0].node_indices = vec![0, 1, 3, 7];
        duplicate_marker[1].element_selector =
            fullmag_ir::FemMeshPartSelector::ElementRange { start: 1, count: 2 };
        duplicate_marker[1].node_selector =
            fullmag_ir::FemMeshPartSelector::NodeRange { start: 1, count: 0 };
        duplicate_marker[1].node_indices = vec![0, 2, 3, 6, 7];
        assert_modal_v6_part_registry_error(&mesh, &duplicate_marker, "magnetic_marker_duplicate");
    }

    #[test]
    fn modal_v6_part_registry_rejects_id_role_and_selector_mutations() {
        let mesh = modal_v6_xy_shared_domain_mesh();
        let parts = modal_v6_xy_mesh_parts();
        let (magnetic, air) = modal_v6_part_identities(&mesh, &parts, 8).unwrap();
        assert!(magnetic.contains("part:film"));
        assert!(air.contains("part:__air__"));

        let mut id_mutation = parts.clone();
        id_mutation[0].id = "part:renamed".to_string();
        assert!(modal_v6_part_identities(&mesh, &id_mutation, 8).is_err());

        let mut role_mutation = parts.clone();
        role_mutation[0].role = fullmag_ir::FemMeshPartRole::Air;
        assert!(modal_v6_part_identities(&mesh, &role_mutation, 8).is_err());

        let mut selector_mutation = parts;
        selector_mutation[0].node_selector =
            fullmag_ir::FemMeshPartSelector::NodeRange { start: 1, count: 7 };
        assert!(modal_v6_part_identities(&mesh, &selector_mutation, 8).is_err());
    }

    #[test]
    fn modal_v6_owned_producer_builds_xy_edge_closure_and_keeps_z_open() {
        let mesh = modal_v6_xy_shared_domain_mesh();
        let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
        let (scalar, scalar_count, magnetic, magnetic_count) =
            modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
        let certificate = accepted_modal_v6_certificate(&mesh);

        let binding = build_owned_modal_certificate_v6_binding(
            &mesh,
            &certificate,
            &modal_v6_xy_mesh_parts(),
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            7,
            &[20_000.0, 0.0, 0.0],
        )
        .expect("complete x/y producer must validate");

        assert_eq!(binding.mesh_magnetic.node_count(), 8);
        assert_eq!(binding.mesh_scalar.node_count(), 16);
        assert!(binding
            .mesh_magnetic
            .closure_relations
            .iter()
            .any(|relation| relation.axis_mask == 3 && relation.kind == 2));
        assert!(binding
            .mesh_scalar
            .boundary_axis_masks
            .iter()
            .all(|mask| mask & 4 == 0));
        assert!(binding.canonical_preimage.starts_with(
            "periodic_modal_equivalence_map_binding.v1\nschema=periodic_mesh_certificate.v6\n"
        ));
        assert!(binding.canonical_preimage_sha256.starts_with("sha256:"));
        assert!(binding
            .shared_domain_map_binding_sha256
            .starts_with("sha256:"));
        binding
            .validate()
            .expect("owned producer must self-validate");
    }

    fn modal_v6_owned_binding_fixture() -> OwnedModalCertificateV6Binding {
        let mesh = modal_v6_xy_shared_domain_mesh();
        let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
        let (scalar, scalar_count, magnetic, magnetic_count) =
            modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
        build_owned_modal_certificate_v6_binding(
            &mesh,
            &accepted_modal_v6_certificate(&mesh),
            &modal_v6_xy_mesh_parts(),
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            7,
            &[20_000.0, 0.0, 0.0],
        )
        .expect("fixture binding must validate")
    }

    #[test]
    fn modal_v6_owned_producer_rejects_missing_axis_and_interleaved_magnetic_nodes() {
        let mesh = modal_v6_xy_shared_domain_mesh();
        let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
        let (scalar, scalar_count, magnetic, magnetic_count) =
            modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
        let mut certificate = accepted_modal_v6_certificate(&mesh);
        certificate
            .axis_pairs
            .retain(|axis| axis.axis.as_deref() != Some("y"));
        let axis_error = build_owned_modal_certificate_v6_binding(
            &mesh,
            &certificate,
            &modal_v6_xy_mesh_parts(),
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            0,
            &[0.0, 0.0, 0.0],
        )
        .expect_err("missing accepted y-axis evidence must fail closed");
        assert!(axis_error
            .message
            .contains("accepted_certificate_missing_or_stale"));

        let mut swapped_certificate = accepted_modal_v6_certificate(&mesh);
        for evidence in &mut swapped_certificate.axis_pairs {
            evidence.axis = match evidence.axis.as_deref() {
                Some("x") => Some("y".to_string()),
                Some("y") => Some("x".to_string()),
                _ => evidence.axis.clone(),
            };
        }
        let swapped_error = build_owned_modal_certificate_v6_binding(
            &mesh,
            &swapped_certificate,
            &modal_v6_xy_mesh_parts(),
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            0,
            &[0.0, 0.0, 0.0],
        )
        .expect_err("swapped x/y certificate evidence must fail closed");
        assert!(swapped_error
            .message
            .contains("accepted_certificate_missing_or_stale"));

        let mut stale_certificate = accepted_modal_v6_certificate(&mesh);
        stale_certificate.topology_fingerprint = format!("sha256:{}", "0".repeat(64));
        let stale_error = build_owned_modal_certificate_v6_binding(
            &mesh,
            &stale_certificate,
            &modal_v6_xy_mesh_parts(),
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            0,
            &[0.0, 0.0, 0.0],
        )
        .expect_err("stale certificate topology fingerprint must fail closed");
        assert!(stale_error
            .message
            .contains("accepted_certificate_missing_or_stale"));

        let mut rejected_certificate = accepted_modal_v6_certificate(&mesh);
        rejected_certificate.certificate_status = "rejected".to_string();
        let rejected_error = build_owned_modal_certificate_v6_binding(
            &mesh,
            &rejected_certificate,
            &modal_v6_xy_mesh_parts(),
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            0,
            &[0.0, 0.0, 0.0],
        )
        .expect_err("non-accepted certificate must fail closed");
        assert!(rejected_error
            .message
            .contains("accepted_certificate_missing_or_stale"));

        let mut interleaved = modal_v6_xy_shared_domain_mesh();
        interleaved.nodes.swap(1, 8);
        let remap = |node: u32| match node {
            1 => 8,
            8 => 1,
            value => value,
        };
        let remapped_cells = interleaved
            .require_tet4_elements()
            .unwrap()
            .iter()
            .map(|cell| cell.map(remap))
            .collect();
        interleaved.set_tet4_cells(remapped_cells);
        for pair in &mut interleaved.periodic_node_pairs {
            pair.node_a = remap(pair.node_a);
            pair.node_b = remap(pair.node_b);
        }
        let interleaved_errors = interleaved
            .periodic_mesh_certificate_v6()
            .expect_err("authoritative certificate generation must reject interleaved nodes");
        assert!(interleaved_errors
            .iter()
            .any(|error| error.contains("magnetic nodes do not form an exact leading prefix")));
    }

    #[test]
    fn modal_v6_owned_producer_rejects_all_authoritative_certificate_evidence_mutations() {
        let mesh = modal_v6_xy_shared_domain_mesh();
        let topology = MeshTopology::from_ir(&mesh).unwrap();
        let (scalar, scalar_count, magnetic, magnetic_count) =
            modal_shared_domain_equivalence_classes(&topology).unwrap();
        let authoritative = accepted_modal_v6_certificate(&mesh);
        let assert_rejected = |label: &str, certificate| {
            let error = build_owned_modal_certificate_v6_binding(
                &mesh,
                &certificate,
                &modal_v6_xy_mesh_parts(),
                None,
                None,
                &scalar,
                scalar_count,
                &magnetic,
                magnetic_count,
                "robin",
                99,
                2.0,
                0,
                &[0.0, 0.0, 0.0],
            )
            .expect_err("mutated authoritative evidence must fail before FFI");
            assert!(
                error
                    .message
                    .contains("accepted_certificate_missing_or_stale"),
                "{label}: {}",
                error.message
            );
        };

        let mut mutations = Vec::<(&str, fullmag_ir::PeriodicMeshCertificateV6IR)>::new();
        macro_rules! mutate {
            ($label:literal, $mutation:expr) => {{
                let mut certificate = authoritative.clone();
                $mutation(&mut certificate);
                mutations.push(($label, certificate));
            }};
        }
        mutate!(
            "schema_version",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.schema_version.push('0')
        );
        mutate!(
            "certificate_status",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.certificate_status =
                "rejected".to_string()
        );
        mutate!(
            "topology_fingerprint",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .topology_fingerprint
                .push('0')
        );
        mutate!(
            "magnetic_class_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.magnetic_class_count += 1
        );
        mutate!(
            "magnetic_pair_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.magnetic_pair_count += 1
        );
        mutate!(
            "scalar_class_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.scalar_class_count += 1
        );
        mutate!(
            "scalar_pair_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.scalar_pair_count += 1
        );
        mutate!(
            "magnetic_digest",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .magnetic_equivalence_classes_sha256
                .push('0')
        );
        mutate!(
            "scalar_digest",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .scalar_equivalence_classes_sha256
                .push('0')
        );
        mutate!(
            "edge_class_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.edge_class_count += 1
        );
        mutate!(
            "corner_class_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.corner_class_count += 1
        );
        mutate!(
            "region_class_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.region_class_count += 1
        );
        mutate!(
            "translation_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .translation_residual_max_m +=
                1.0
        );
        mutate!(
            "orientation_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.orientation_residual_max +=
                1.0
        );
        mutate!(
            "normal_mismatch",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.normal_mismatch_max += 1.0
        );
        mutate!(
            "commutation_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .max_commutation_residual_m +=
                1.0
        );
        mutate!(
            "material_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.max_material_residual +=
                1.0
        );
        mutate!(
            "boundary_topology_match",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.boundary_topology_match =
                !value.boundary_topology_match
        );
        mutate!(
            "fe_order_match",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.fe_order_match =
                !value.fe_order_match
        );
        mutate!(
            "material_region_match",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.material_region_match =
                !value.material_region_match
        );
        mutate!(
            "corner_edge_cycle_unique",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.corner_edge_cycle_unique =
                !value.corner_edge_cycle_unique
        );
        mutate!(
            "m0_seam_mismatch",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.m0_seam_mismatch_max += 1.0
        );
        mutate!(
            "h_demag0_seam_mismatch",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .h_demag0_seam_mismatch_max +=
                1.0
        );
        mutate!(
            "marker_map_fingerprint",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .marker_map_fingerprint
                .push('0')
        );
        mutate!(
            "material_realization_fingerprint",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
                .material_realization_fingerprint
                .push('0')
        );
        mutate!(
            "axis_pair_id",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .pair_id
                .push('0')
        );
        mutate!(
            "axis_identity",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].axis =
                Some("z".to_string())
        );
        mutate!(
            "axis_node_pair_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .node_pair_count += 1
        );
        mutate!(
            "axis_face_pair_count",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .face_pair_count += 1
        );
        mutate!(
            "axis_translation_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .translation_residual_max_m +=
                1.0
        );
        mutate!(
            "axis_orientation_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .orientation_residual_max +=
                1.0
        );
        mutate!(
            "axis_normal_mismatch",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .normal_mismatch_max += 1.0
        );
        mutate!(
            "axis_boundary_match",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .boundary_topology_match =
                !value.axis_pairs[0].boundary_topology_match
        );
        mutate!(
            "axis_material_match",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
                .material_region_match =
                !value.axis_pairs[0].material_region_match
        );
        mutate!(
            "face_pair_identity",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .face_a += 1
        );
        mutate!(
            "face_pair_destination",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .face_b += 1
        );
        mutate!(
            "face_vertex_pair",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .vertex_pairs[0][0] += 1
        );
        mutate!(
            "face_vertex_destination",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .vertex_pairs[0][1] += 1
        );
        mutate!(
            "face_translation_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .translation_residual_max_m +=
                1.0
        );
        mutate!(
            "face_area_residual",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .area_residual_m2 += 1.0
        );
        mutate!(
            "face_normal_dot",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .normal_dot += 1.0
        );
        mutate!(
            "face_source_marker",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .source_marker += 1
        );
        mutate!(
            "face_destination_marker",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .destination_marker += 1
        );
        mutate!(
            "face_source_region",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .source_element_markers[0] += 1
        );
        mutate!(
            "face_destination_region",
            |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs
                [0]
            .destination_element_markers[0] +=
                1
        );

        for (label, certificate) in mutations {
            assert_rejected(label, certificate);
        }
    }

    #[test]
    fn modal_v6_owned_binding_rejects_relation_identity_and_digest_mutations() {
        let baseline = modal_v6_owned_binding_fixture();

        let mut missing_scalar_relation = baseline.clone();
        missing_scalar_relation
            .mesh_scalar
            .generator_relations
            .pop();
        assert!(missing_scalar_relation.validate().is_err());

        let mut missing_edge = baseline.clone();
        missing_edge
            .mesh_magnetic
            .closure_relations
            .retain(|relation| relation.axis_mask != 3);
        assert!(missing_edge.validate().is_err());

        let mut relation_endpoint = baseline.clone();
        relation_endpoint.mesh_magnetic.generator_relations[0].destination_node = 7;
        assert!(relation_endpoint.validate().is_err());

        let mut relation_axis = baseline.clone();
        relation_axis.mesh_magnetic.generator_relations[0].axis_mask ^= 2;
        assert!(relation_axis.validate().is_err());

        let mut relation_kind = baseline.clone();
        relation_kind.mesh_magnetic.generator_relations[0].kind += 1;
        assert!(relation_kind.validate().is_err());

        let mut part_identity = baseline.clone();
        part_identity.mesh_scalar.part_identity = "airbox:mutated".to_string();
        assert!(part_identity.validate().is_err());

        let mut marker_map = baseline.clone();
        marker_map.cell_markers[0] = 0;
        assert!(marker_map.validate().is_err());

        let mut class_id = baseline.clone();
        class_id.mesh_magnetic.expected_class_ids[0] += 1;
        assert!(class_id.validate().is_err());

        let mut class_digest = baseline.clone();
        class_digest.mesh_scalar.expected_class_digests[0].sha256 =
            format!("sha256:{}", "0".repeat(64));
        assert!(class_digest.validate().is_err());

        let mut canonical_preimage = baseline.clone();
        canonical_preimage.canonical_preimage.push('x');
        assert!(canonical_preimage.validate().is_err());

        let mut map_digest = baseline.clone();
        map_digest.shared_domain_map_binding_sha256 = format!("sha256:{}", "0".repeat(64));
        assert!(map_digest.validate().is_err());

        let mut bias_signature = baseline;
        bias_signature.bias_field_sample_signature = format!("sha256:{}", "0".repeat(64));
        assert!(bias_signature.validate().is_err());

        let mut boundary_identity = modal_v6_owned_binding_fixture();
        boundary_identity.boundary_gauge_digest = format!("sha256:{}", "0".repeat(64));
        assert!(boundary_identity.validate().is_err());
    }

    #[test]
    fn modal_v6_cross_language_golden_matches_native_preimage_and_class_digests() {
        let relations = [(0, 1, 1), (2, 3, 1), (0, 2, 2), (1, 3, 2)]
            .into_iter()
            .map(
                |(source_node, destination_node, axis_mask)| OwnedModalCertificateV6Relation {
                    source_node,
                    destination_node,
                    axis_mask,
                    kind: 1,
                },
            )
            .collect::<Vec<_>>();
        let closure = relations
            .iter()
            .cloned()
            .chain([
                OwnedModalCertificateV6Relation {
                    source_node: 0,
                    destination_node: 3,
                    axis_mask: 3,
                    kind: 2,
                },
                OwnedModalCertificateV6Relation {
                    source_node: 1,
                    destination_node: 2,
                    axis_mask: 3,
                    kind: 2,
                },
            ])
            .collect::<Vec<_>>();
        let make_view = |view_kind, part_role, identity: &str, topology: &str, region_id| {
            let mut view = OwnedModalCertificateV6View {
                view_kind,
                part_role,
                part_identity: identity.to_string(),
                topology_fingerprint: topology.to_string(),
                region_ids: vec![region_id; 4],
                boundary_axis_masks: vec![0, 1, 2, 3],
                region_roles: vec![OwnedModalCertificateV6RegionRole {
                    region_id,
                    part_role,
                }],
                generator_relations: relations.clone(),
                closure_relations: closure.clone(),
                expected_class_ids: Vec::new(),
                expected_class_digests: Vec::new(),
            };
            let (ids, digests, _) = view.canonical_state().unwrap();
            view.expected_class_ids = ids;
            view.expected_class_digests = digests;
            view
        };
        let magnetic = make_view(
            1,
            1,
            "magnetic:film:v1",
            &format!("sha256:{}", "1".repeat(64)),
            7,
        );
        let scalar = make_view(
            1,
            2,
            "airbox:poisson:v1",
            &format!("sha256:{}", "2".repeat(64)),
            100,
        );
        assert_eq!(
            magnetic.expected_class_digests[0].sha256,
            "sha256:88feeb3b3663fbb296e50c8f7793b69577d882945f921a5d296cbbd0d93cebac"
        );
        assert_eq!(
            scalar.expected_class_digests[0].sha256,
            "sha256:7ff33f86d0dc4a728a5beaf03ef9b05fb20ee1821b92218d846272a01db7366c"
        );
        let preimage =
            modal_v6_canonical_preimage("mesh-generation:periodic-film-v1", &magnetic, &scalar)
                .unwrap();
        assert_eq!(
            sha256_text(&preimage),
            "sha256:4397ddf3cf87bf263647dfc9d0d7f1e95ceda79ffe0b547ba99497e4d79c23a7"
        );
        let (_, _, magnetic_aggregate) = magnetic.canonical_state().unwrap();
        let (_, _, scalar_aggregate) = scalar.canonical_state().unwrap();
        let map_digest = modal_shared_domain_map_binding_digest(
            "mesh-generation:periodic-film-v1",
            &magnetic,
            &scalar,
            &sha256_text(&preimage),
            &magnetic_aggregate,
            &scalar_aggregate,
            &[1, 0],
            &[0, 0, 0, 0],
            1,
            &[0, 0, 0, 0],
            1,
        )
        .unwrap();
        assert_eq!(
            map_digest,
            "sha256:ba9534bd23575cdb97bc6224d8e6acbe07c04e3e0a180e417283953b9d849f67"
        );

        let corner_generators = (0_u64..8)
            .flat_map(|source| {
                [1_u32, 2, 4].into_iter().filter_map(move |axis_mask| {
                    (source & axis_mask as u64 == 0).then_some(OwnedModalCertificateV6Relation {
                        source_node: source,
                        destination_node: source | axis_mask as u64,
                        axis_mask,
                        kind: 1,
                    })
                })
            })
            .collect::<Vec<_>>();
        let corner_closure = (0_u64..8)
            .flat_map(|source| {
                (source + 1..8).map(move |destination| {
                    let axis_mask = (source ^ destination) as u32;
                    OwnedModalCertificateV6Relation {
                        source_node: source,
                        destination_node: destination,
                        axis_mask,
                        kind: axis_mask.count_ones(),
                    }
                })
            })
            .collect::<Vec<_>>();
        let mut corner_view = OwnedModalCertificateV6View {
            view_kind: 1,
            part_role: 1,
            part_identity: "magnetic:corner:v1".to_string(),
            topology_fingerprint: format!("sha256:{}", "3".repeat(64)),
            region_ids: vec![7; 8],
            boundary_axis_masks: (0..8).collect(),
            region_roles: vec![OwnedModalCertificateV6RegionRole {
                region_id: 7,
                part_role: 1,
            }],
            generator_relations: corner_generators,
            closure_relations: corner_closure,
            expected_class_ids: Vec::new(),
            expected_class_digests: Vec::new(),
        };
        let (ids, digests, _) = corner_view.canonical_state().unwrap();
        corner_view.expected_class_ids = ids;
        corner_view.expected_class_digests = digests;
        corner_view.validate(1).unwrap();
        corner_view
            .closure_relations
            .retain(|relation| relation.axis_mask != 7);
        let corner_error = corner_view
            .canonical_state()
            .expect_err("missing x/y/z corner closure must fail closed");
        assert!(corner_error.message.contains("corner_closure_incomplete"));
    }

    fn minimal_native_modal_plan() -> FemEigenPlanIR {
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: "native_modal_mesh".to_string(),
            mesh_source: None,
            mesh: fullmag_ir::MeshIR {
                mesh_name: "native_modal_mesh".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            equilibrium_magnetization: vec![
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
            ],
            material: fullmag_ir::MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 8.0e5,
                exchange_stiffness: 1.3e-11,
                damping: 0.01,
                uniaxial_anisotropy: None,
                uniaxial_anisotropy_k2: None,
                anisotropy_axis: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 6,
            target: fullmag_ir::EigenTargetIR::FrequencyWindow {
                frequency_min_hz: 1.0e8,
                frequency_max_hz: 5.0e9,
            },
            equilibrium: EquilibriumSourceIR::RelaxedInitialState,
            k_sampling: Some(KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            bias_field_samples: Vec::new(),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Include,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    }

    fn add_minimal_shared_domain_periodic_airbox(plan: &mut FemEigenPlanIR) {
        let (mesh, mesh_parts) = modal_v6_multi_part_mesh_and_parts();
        plan.mesh = mesh;
        plan.mesh_parts = mesh_parts;
        plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("dipole".to_string()),
            robin_beta_factor: Some(2.0),
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
    }

    #[test]
    fn modal_participation_context_aggregates_same_object_parts_by_markers() {
        let mut plan = minimal_native_modal_plan();
        add_minimal_shared_domain_periodic_airbox(&mut plan);

        let context = modal_participation_mesh_context(&plan)
            .expect("canonical magnetic mesh parts must define participation membership");

        assert_eq!(context.source_mesh_identity.mesh_id, plan.mesh_name);
        assert_eq!(context.source_mesh_identity.node_count, plan.mesh.nodes.len());
        assert_eq!(context.object_marker_membership.len(), 1);
        assert_eq!(context.object_marker_membership[0].object_id, "body");
        assert_eq!(context.object_marker_membership[0].markers, vec![1, 2]);
    }

    fn add_x_floquet_pair_to_plan(plan: &mut FemEigenPlanIR) {
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
    }

    #[test]
    fn native_eigen_v2_mode_metadata_preserves_operator_provenance() {
        let plan = minimal_native_modal_plan();
        let provenance = serde_json::json!({
            "external_field_a_per_m": [3978.8735772973837, 0.0, 0.0],
            "assembly_kind": "mfem_weak_form_shared_domain",
            "operator_input_signature_sha256": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "phase_constraint_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "equilibrium_artifact_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "linearization_state_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "relax_to_eigen_handoff_sha256": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "source_mesh_topology_sha256": plan.mesh.topology_fingerprint_v6(),
            "periodic_mesh_certificate_sha256": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        });
        let mut legacy_mode = serde_json::json!({
            "index": 0,
            "frequency_hz": 1.0e9,
            "frequency_real_hz": 1.0e9,
            "frequency_imag_hz": 0.0,
            "angular_frequency_rad_per_s": std::f64::consts::TAU * 1.0e9,
            "omega_rad_s": std::f64::consts::TAU * 1.0e9,
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": std::f64::consts::TAU * 1.0e9,
            "normalization": "unit_l2",
            "damping_policy": "ignore",
            "residual_norm": 1.0e-10,
            "residual_absolute_l2": 1.0e-10,
            "residual_relative_l2": 1.0e-10,
            "residual_linf": 1.0e-10,
            "mass_norm": 1.0,
            "tangent_leakage_mean_abs": 0.0,
            "tangent_leakage_max_abs": 0.0,
            "phasor_convention": "exp_plus_i_omega_t",
            "eigenvalue_mapping": "lambda_imag_positive_frequency",
            "gamma_rad_s_T": 1.0,
            "gamma0_rad_s_per_A_m": 2.211e5,
            "mu0_T_m_per_A": MU0,
            "dominant_polarization": "uniform",
            "k_vector": [0.0, 0.0, 0.0],
            "real": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0]],
            "imag": [[0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 1.0]],
            "amplitude": [1.0, 1.0, 1.0, 1.0],
        });
        for (key, value) in provenance.as_object().expect("provenance object") {
            legacy_mode[key] = value.clone();
        }
        let summary = serde_json::json!({
            "solver_kind": "k0_poisson_airbox_gpu_petsc_slepc",
            "modes": [legacy_mode.clone()],
        });
        let mut artifacts = vec![json_artifact("eigen/modes/mode_0000.json", &legacy_mode)
            .expect("legacy mode artifact should serialize")];
        write_eigen_v2_bundle(
            &plan,
            &summary,
            &std::collections::BTreeSet::from([0_u32]),
            &mut artifacts,
            0,
        )
        .expect("native v2 bundle should write");

        let spectrum_v2 = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/spectrum.v2.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("spectrum.v2 must be emitted");
        assert!(spectrum_v2["samples"][0]["modes"][0]
            .get("component_participation")
            .is_none());
        let spectrum_v3 = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/spectrum.v3.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("spectrum.v3 must be emitted");
        assert_eq!(spectrum_v3["schema_version"], "eigen_spectrum.v3");
        assert_eq!(
            spectrum_v3["samples"][0]["modes"][0]["component_participation"]["status"],
            "unavailable"
        );

        let nested = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/modes/sample_0000/mode_0000.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("nested mode metadata should be emitted");
        for key in provenance.as_object().expect("provenance object").keys() {
            assert_eq!(nested[key], provenance[key], "nested mode lost {key}");
        }
        assert_eq!(
            nested["source_mesh_identity"],
            serde_json::json!({
                "mesh_id": plan.mesh_name,
                "topology_fingerprint": plan.mesh.topology_fingerprint_v6(),
                "indexing": "full_domain_node_order",
                "node_count": plan.mesh.nodes.len(),
            })
        );
        let chunk = artifacts
            .iter()
            .find(|artifact| {
                artifact.relative_path
                    == "eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0"
            })
            .expect("canonical Zarr v2 mode chunk should be emitted");
        assert_eq!(
            nested["payload_sha256"],
            format!("sha256:{:x}", Sha256::digest(&chunk.bytes))
        );
    }

    #[test]
    fn native_eigen_v2_rejects_requested_mode_without_cartesian_complex_payload() {
        let plan = minimal_native_modal_plan();
        let summary = serde_json::json!({
            "solver_kind": "k0_poisson_airbox_cpu_petsc_slepc",
            "modes": [{"index": 0}],
        });
        let mut artifacts = Vec::new();

        let error = write_eigen_v2_bundle(
            &plan,
            &summary,
            &std::collections::BTreeSet::from([0_u32]),
            &mut artifacts,
            0,
        )
        .expect_err("a requested field export without payload must fail closed");

        assert!(error.message.contains("requested mode 0"));
    }

    #[test]
    fn native_eigen_v2_rejects_malformed_or_asymmetric_complex_xyz_payload() {
        let plan = minimal_native_modal_plan();
        let summary = serde_json::json!({
            "solver_kind": "k0_poisson_airbox_cpu_petsc_slepc",
            "modes": [{"index": 0}],
        });
        let malformed = serde_json::json!({
            "real": [[1.0, 0.0]],
            "imag": [[0.0, 1.0, 0.0]],
        });
        let mut artifacts = vec![json_artifact("eigen/modes/mode_0000.json", &malformed)
            .expect("fixture should serialize")];

        let error = write_eigen_v2_bundle(
            &plan,
            &summary,
            &std::collections::BTreeSet::from([0_u32]),
            &mut artifacts,
            0,
        )
        .expect_err("a malformed Cartesian component must fail closed");

        assert!(error.message.contains("real[0]"));
    }

    #[test]
    fn native_field_sweep_binds_published_sources_and_has_own_content_digest() {
        let spectrum = serde_json::json!({
            "samples": [{
                "sample_index": 7,
                "external_field_a_per_m": [40_000.0, 0.0, 0.0],
                "mesh_id": "mesh:periodic-airbox",
                "topology_revision": "sha256:mesh-revision",
                "modes": [{
                    "raw_mode_index": 2,
                    "frequency_hz": 6.1e9,
                    "angular_frequency_rad_per_s": std::f64::consts::TAU * 6.1e9,
                    "mode_field_id": "analysis:eigen:sample-0007:mode-0002",
                    "mode_field_resource_key": "/v2/sessions/current/data/fields/analysis:eigen:sample-0007:mode-0002/samples/vector",
                    "residual_relative_l2": 1.0e-10,
                    "equilibrium_artifact_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "linearization_state_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "operator_input_signature_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                }]
            }]
        });
        let branches = serde_json::json!({
            "branches": [{
                "branch_id": 3,
                "points": [{"sample_index": 7, "raw_mode_index": 2}]
            }]
        });
        let diagnostics = serde_json::json!({
            "requested_execution": {"backend": "fem", "device": "cpu"},
            "resolved_execution": {"backend": "fem", "device": "cpu"}
        });
        let artifacts = vec![
            json_artifact("eigen/spectrum.v2.json", &spectrum)
                .expect("spectrum fixture should serialize"),
            json_artifact("eigen/branches.v2.json", &branches)
                .expect("branches fixture should serialize"),
        ];

        let artifact = build_native_field_sweep_artifact(
            &spectrum,
            &branches,
            &diagnostics,
            &artifacts,
            1,
            RunStatus::Completed,
            None,
        )
        .expect("complete native field sweep should be serializable");
        let spectrum_revision = published_artifact_sha256(&artifacts, "eigen/spectrum.v2.json")
            .expect("published spectrum digest should resolve");
        let branches_revision = published_artifact_sha256(&artifacts, "eigen/branches.v2.json")
            .expect("published branches digest should resolve");

        assert_eq!(artifact["source"]["revision"], spectrum_revision);
        assert_eq!(artifact["source_revision"], spectrum_revision);
        assert_eq!(artifact["revision"], artifact["content_sha256"]);
        let mut normalized_envelope = artifact.clone();
        normalized_envelope["revision"] = serde_json::Value::String(String::new());
        normalized_envelope["content_sha256"] = serde_json::Value::String(String::new());
        let expected_content_digest = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&normalized_envelope)
                    .expect("normalized field-sweep envelope should serialize")
            )
        );
        assert_eq!(artifact["revision"], expected_content_digest);
        assert_ne!(
            artifact["revision"], artifact["source_revision"],
            "the field-sweep envelope must not reuse the spectrum source digest"
        );
        assert_eq!(
            artifact["cross_artifact_refs"],
            serde_json::json!([
                {"relation": "source_spectrum", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
                {"relation": "source_branches", "artifact": "eigen/branches.v2.json", "revision": branches_revision},
            ])
        );
    }

    fn scope_observables(node_count: usize, max_torque_apm: f64) -> EffectiveFieldObservables {
        let zeros = vec![[0.0, 0.0, 0.0]; node_count];
        let x_field = vec![[1.0, 0.0, 0.0]; node_count];
        EffectiveFieldObservables {
            magnetization: x_field.clone(),
            exchange_field: zeros.clone(),
            demag_field: zeros.clone(),
            external_field: x_field.clone(),
            effective_field: x_field,
            dmi_field: zeros,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 1.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            max_torque_Apm: max_torque_apm,
        }
    }

    #[test]
    fn native_modal_target_frequency_uses_the_authored_request() {
        assert_eq!(
            native_modal_target_frequency_hz(&fullmag_ir::EigenTargetIR::Lowest),
            0.0
        );
        assert_eq!(
            native_modal_target_frequency_hz(&fullmag_ir::EigenTargetIR::Nearest {
                frequency_hz: 1.25e9,
            }),
            1.25e9
        );
        assert_eq!(
            native_modal_target_frequency_hz(&fullmag_ir::EigenTargetIR::FrequencyWindow {
                frequency_min_hz: 2.0e9,
                frequency_max_hz: 4.0e9,
            }),
            3.0e9
        );
    }

    #[test]
    fn sparse_eigen_threshold_covers_mid_sized_full_2x2_smoke_meshes() {
        assert!(
            SPARSE_EIGEN_THRESHOLD <= 3_000,
            "mid-sized full 2x2 FEM eigensolve smoke meshes must use sparse LOBPCG instead of dense O(n^3) diagonalization"
        );
    }

    #[test]
    fn frequency_window_sparse_lobpcg_oversamples_candidates() {
        let target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 2.0,
        };

        assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 10), 10);
        assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 50), 50);
        assert!(sparse_lobpcg_candidate_count(&target, 20, 200) > 20);
        assert!(sparse_lobpcg_candidate_count(&target, 40, 10_000) > 40);
    }

    #[test]
    fn native_modal_gyrotropic_pencil_uses_exp_i_omega_t_sign() {
        let mass = DMatrix::identity(2, 2);

        let gyrotropic = gyrotropic_matrix_row_major_from_tangent_mass(&mass, 1)
            .expect("single macrospin tangent mass should build a pencil matrix");

        assert_eq!(gyrotropic, vec![0.0, 1.0, -1.0, 0.0]);
    }

    #[test]
    fn native_modal_magnetic_pencil_request_carries_payload_digest_and_canonical_gamma0() {
        let mut plan = minimal_native_modal_plan();
        plan.gyromagnetic_ratio = 1.987_654e5;
        let stiffness = vec![2.0, 0.0, 0.0, 3.0];
        let gyrotropic = vec![0.0, 1.0, -1.0, 0.0];
        let mass = vec![1.0, 0.0, 0.0, 1.0];

        let pencil =
            native_modal_magnetic_pencil_payload(&plan, &stiffness, &gyrotropic, &mass, &[]);
        let request =
            native_modal_mfem_operator_problem(2, &stiffness, &gyrotropic, &mass, &pencil, &[]);

        assert!(!pencil.dependency_digest.is_empty());
        assert_eq!(
            request.linearized_pencil_dependency_digest,
            Some(pencil.dependency_digest.as_str())
        );
        assert_eq!(
            request.linearized_pencil_gamma0_m_per_a_s,
            plan.gyromagnetic_ratio
        );

        let changed_stiffness = vec![2.5, 0.0, 0.0, 3.0];
        assert_ne!(
            pencil.dependency_digest,
            native_modal_magnetic_pencil_payload(
                &plan,
                &changed_stiffness,
                &gyrotropic,
                &mass,
                &[],
            )
            .dependency_digest
        );
    }

    #[test]
    fn native_modal_provenance_uses_the_native_canonical_digest_known_vector() {
        let mut digest = CanonicalDigestBuilder::new("mfem_linearized_jvp_dependencies.v2");
        digest.add_string("label", "cross-language");
        digest.add_u64("count", 7);
        digest.add_double("negative_zero", -0.0);
        digest.add_double("nan", f64::NAN);
        digest.add_bytes("bytes", &[0x01, 0x02, 0xfe]);
        assert_eq!(
            digest.sha256_hex(),
            "1167f46ac77502f652f4fc5464070023419244dbd654d907970bd73e504afcbc"
        );
    }

    #[test]
    fn native_modal_node_mass_weights_average_tangent_component_diagonals() {
        let mass = DMatrix::from_diagonal(&DVector::from_vec(vec![2.0, 4.0, 6.0, 10.0]));

        let weights = node_mass_weights_from_tangent_mass(&mass, 2)
            .expect("positive 2N tangent mass diagonal should produce per-node weights");

        assert_eq!(weights, vec![4.0, 7.0]);
    }

    #[test]
    fn native_modal_full_2x2_operator_diagnostics_reports_frequency_range() {
        let mut plan = minimal_native_modal_plan();
        plan.gyromagnetic_ratio = std::f64::consts::TAU;
        let stiffness = DMatrix::identity(2, 2);
        let mass = DMatrix::identity(2, 2);

        let diagnostics = full_2x2_native_operator_diagnostics_json(&plan, &stiffness, &mass, 1);

        assert_eq!(diagnostics["payload_kind"], "rust_full_2x2_dense_operator");
        assert_eq!(
            diagnostics["generalized_field_spectrum_status"],
            "available"
        );
        assert_eq!(
            diagnostics["generalized_field_positive_eigenvalue_count"],
            2
        );
        assert!(
            (diagnostics["generalized_positive_frequency_min_hz"]
                .as_f64()
                .expect("minimum frequency should be numeric")
                - 1.0)
                .abs()
                < 1.0e-12
        );
    }

    #[test]
    fn native_modal_full_2x2_operator_diagnostics_labels_floquet_pair_payload() {
        let mut plan = minimal_native_modal_plan();
        add_x_floquet_pair_to_plan(&mut plan);
        let stiffness = DMatrix::identity(2, 2);
        let mass = DMatrix::identity(2, 2);

        let diagnostics = full_2x2_native_operator_diagnostics_json(&plan, &stiffness, &mass, 1);

        assert_eq!(
            diagnostics["payload_kind"],
            "bloch_floquet_tangent_operator"
        );
    }

    #[test]
    fn native_modal_lambda_i_omega_macrospin_mapping_has_positive_frequency_residual() {
        let stiffness_omega = DMatrix::identity(2, 2);
        let mass = DMatrix::identity(2, 2);
        let gyrotropic = gyrotropic_matrix_row_major_from_tangent_mass(&mass, 1)
            .expect("single macrospin tangent mass should build a pencil matrix");
        let lambda = Complex64::new(0.0, 1.0);
        let mode = vec![Complex64::new(1.0, 0.0), Complex64::new(0.0, -1.0)];

        let (absolute, relative, linf) =
            gyrotropic_pencil_residual_norms(&stiffness_omega, &gyrotropic, lambda, &mode);

        assert!(absolute < 1.0e-14);
        assert!(relative < 1.0e-14);
        assert!(linf < 1.0e-14);
        validate_native_modal_lambda_frequency_mapping(
            lambda.im,
            lambda.im,
            1.0 / std::f64::consts::TAU,
        )
        .expect("lambda=i*omega maps to positive frequency for the accepted branch");
    }

    #[test]
    fn native_modal_lambda_i_omega_mapping_rejects_negative_branch() {
        let error =
            validate_native_modal_lambda_frequency_mapping(-1.0, 1.0, 1.0 / std::f64::consts::TAU)
                .expect_err("negative-frequency conjugate branch must not pass as accepted mode");

        assert!(error.message.contains("positive-frequency branch"));
    }

    #[test]
    fn damping_linewidth_uses_exp_i_omega_t_decay_sign() {
        let alpha = 0.05;
        let factor = damping_imaginary_factor(alpha, EigenDampingPolicyIR::Include);

        assert!(factor > 0.0);
        assert!((factor - alpha / (1.0 + alpha * alpha)).abs() < 1.0e-15);
        assert_eq!(
            damping_imaginary_factor(alpha, EigenDampingPolicyIR::Ignore),
            0.0
        );
        assert_eq!(
            damping_imaginary_factor(-alpha, EigenDampingPolicyIR::Include),
            factor
        );
    }

    #[test]
    fn dispersion_csv_maps_positive_imaginary_frequency_to_fwhm_linewidth() {
        let modes = serde_json::json!([
            {
                "index": 3,
                "frequency_hz": 1.0e9,
                "frequency_imag_hz": 2.5e6,
                "angular_frequency_rad_per_s": 2.0 * std::f64::consts::PI * 1.0e9,
                "residual_norm": 1.0e-9
            }
        ]);

        let csv = dispersion_v2_csv(None, &modes, &BTreeSet::from([3_u64]));
        let header = csv
            .lines()
            .next()
            .expect("dispersion CSV should include a header");
        assert!(header.contains("tracking_score_source"));
        assert!(header.contains("mode_field_id"));
        assert!(header.contains("mode_field_resource_key"));
        let row = csv
            .lines()
            .nth(1)
            .expect("dispersion CSV should include one data row");
        let columns: Vec<&str> = row.split(',').collect();

        assert_eq!(columns[6], "3");
        assert_eq!(columns[7], "3");
        assert_eq!(columns[10], "5.0000000000000000e6");
        assert_eq!(columns[13], "seed");
        assert_eq!(columns[14], "analysis:eigen:sample-0000:mode-0003");
        assert_eq!(
            columns[15],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0003/samples/vector?view=phase_rotated_real&phase_rad=0"
        );
    }

    #[test]
    fn non_window_sparse_lobpcg_keeps_requested_count() {
        let target = fullmag_ir::EigenTargetIR::Lowest;

        assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 200), 20);
    }

    #[test]
    fn sparse_frequency_window_without_retained_modes_fails_clearly() {
        let target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 2.0,
        };

        let error = reject_empty_frequency_window_result(&target, 60, 60, 0)
            .expect_err("empty sparse frequency-window results must not look successful");
        assert!(error
            .message
            .contains("cannot guarantee interior-window coverage"));
    }

    #[test]
    fn frequency_window_solver_diagnostics_publish_completeness() {
        let plan = minimal_native_modal_plan();

        let diagnostics = modal_solver_diagnostics_json(&plan, "cpu_sparse_lobpcg", 6);

        assert_eq!(
            diagnostics
                .get("resolved_solver_family")
                .and_then(|value| value.as_str()),
            Some("cpu_sparse_lobpcg")
        );
        assert_eq!(
            diagnostics
                .get("spectral_transform")
                .and_then(|value| value.as_str()),
            Some("none")
        );
        assert_eq!(
            diagnostics
                .get("window_completeness")
                .and_then(|value| value.get("policy"))
                .and_then(|value| value.as_str()),
            Some("best_effort")
        );
        assert_eq!(
            diagnostics
                .get("requested_mode_count")
                .and_then(|value| value.as_u64()),
            Some(u64::from(plan.count))
        );
        assert_eq!(
            diagnostics
                .get("window_completeness")
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str()),
            Some("not_certified")
        );
        assert!(diagnostics
            .get("subwindows")
            .and_then(|value| value.as_array())
            .is_some_and(|subwindows| !subwindows.is_empty()));
        let first_subwindow = &diagnostics
            .get("subwindows")
            .and_then(|value| value.as_array())
            .expect("subwindows must be present")[0];
        let requested_hz = first_subwindow
            .get("requested_hz")
            .and_then(|value| value.as_array())
            .expect("subwindow requested_hz must be present");
        let expected_shift_frequency_hz = 0.5
            * (requested_hz[0]
                .as_f64()
                .expect("requested lower bound must be numeric")
                + requested_hz[1]
                    .as_f64()
                    .expect("requested upper bound must be numeric"));
        let shift_frequency_hz = first_subwindow
            .get("shift_frequency_hz")
            .and_then(|value| value.as_f64())
            .expect("subwindow shift_frequency_hz must be present");
        let legacy_shift_hz = first_subwindow
            .get("shift_hz")
            .and_then(|value| value.as_f64())
            .expect("subwindow shift_hz must be present");
        assert_eq!(shift_frequency_hz, legacy_shift_hz);
        assert_eq!(shift_frequency_hz, expected_shift_frequency_hz);
        assert_eq!(
            first_subwindow
                .get("shift_omega_rad_s")
                .and_then(|value| value.as_f64()),
            Some(2.0 * std::f64::consts::PI * shift_frequency_hz)
        );
    }

    #[test]
    fn native_frequency_window_solver_diagnostics_publish_mode_count() {
        let mut plan = minimal_native_modal_plan();
        plan.count = 10;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
        };
        let diagnostics_json = serde_json::json!({
            "accepted_mode_count": 1,
            "accepted_mode_count_after_dedup": 1,
            "resolved_solver_family": "shift_invert",
            "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
            "spectral_transform": "shift_invert",
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "certified_count",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 0,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": true,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0e8, 5.0e9],
                    "search_hz": [7.5e7, 5.125e9],
                    "shift_hz": 2.55e9,
                    "shift_frequency_hz": 2.55e9,
                    "shift_omega_rad_s": std::f64::consts::TAU * 2.55e9,
                    "outer_iterations": 1,
                    "linear_iterations_total": 1,
                    "candidate_modes": 12,
                    "accepted_modes": 1,
                    "residual_max": 0.0,
                    "stop_reason": "converged",
                }
            ],
        });

        let diagnostics_raw =
            serde_json::to_string(&diagnostics_json).expect("diagnostics JSON should serialize");
        let diagnostics = native_solver_diagnostics_json(&plan, &diagnostics_raw, None, None)
            .expect("native diagnostics should be normalized");

        assert_eq!(
            diagnostics
                .get("mode_count")
                .and_then(|value| value.as_u64()),
            Some(1)
        );
        assert_eq!(
            diagnostics
                .get("requested_mode_count")
                .and_then(|value| value.as_u64()),
            Some(10)
        );
    }

    #[test]
    fn native_poisson_airbox_result_metrics_are_preserved_in_solver_diagnostics() {
        let plan = minimal_native_modal_plan();
        let diagnostics_raw = serde_json::json!({
            "resolved_solver_family": "shift_invert",
            "solver_model": "reference_full_2x2_tangent",
            "spectral_transform": "shift_invert",
            "spectral_pencil_kind": "real_frequency_rotated",
            "target_representation": "tau=omega_target",
            "target_tau_rad_s": 2.5e10,
            "outer_boundary_kind": "pure_neumann",
            "robin_beta": 0.0,
            "gauge_policy": "mean_zero_augmented",
            "gauge_reason": "pure_neumann_nullspace",
            "assembly_kind": "mfem_weak_form_shared_domain",
            "metrics": {
                "magnetic_block_backward_error": 4.0e-10,
                "poisson_block_backward_error": 7.0e-10,
                "gauge_constraint_backward_error": 2.0e-10,
                "slepc_reported_backward_error": 1.0e-12,
            },
        })
        .to_string();
        let result_raw = serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "demag_kind": "periodic_airbox_k0",
            "gauge_policy": "mean_zero_augmented",
            "q_dof_count": 2,
            "phi_dof_count": 8,
            "augmented_dof_count": 9,
            "augmented_phi_dof_count": 9,
            "slepc": {
                "accepted_mode_count": 1,
            },
            "metrics": {
                "poisson_constraint_relative_residual": 2.0e-15,
                "full_residual_reconstruction_relative_error": 8.0e-26,
                "relative_reference_frequency_error": 3.0e-16,
            },
            "eigenpair": {
                "omega_rad_s": 2.5e10,
                "frequency_hz": 4.0e9,
            },
        })
        .to_string();

        let diagnostics =
            native_solver_diagnostics_json(&plan, &diagnostics_raw, Some(&result_raw), None)
                .expect("native PA-E2 diagnostics should be normalized");

        assert_eq!(
            diagnostics["solver_adapter"],
            "k0_poisson_airbox_cpu_full_coupled_slepc"
        );
        assert_eq!(
            diagnostics["solver_model"],
            "k0_poisson_airbox_cpu_full_coupled_slepc"
        );
        assert_eq!(
            diagnostics["resolved_solver_family"],
            "k0_poisson_airbox_full_coupled"
        );
        assert_eq!(diagnostics["demag_kind"], "periodic_airbox_k0");
        assert_eq!(diagnostics["augmented_phi_dof_count"], 9);
        assert_eq!(
            diagnostics["poisson_constraint_relative_residual"]
                .as_f64()
                .unwrap(),
            2.0e-15
        );
        assert_eq!(
            diagnostics["relative_reference_frequency_error"]
                .as_f64()
                .unwrap(),
            3.0e-16
        );
        assert_eq!(
            diagnostics["physics_contract_version"],
            "micromagnetics_frequency_domain_v5"
        );
        assert_eq!(diagnostics["implementation_state"], "executable");
        assert_eq!(diagnostics["validation_state"], "unvalidated");
        assert_eq!(diagnostics["execution_lane"], "production_cpu");
        assert_eq!(diagnostics["production_periodic_airbox_claim"], true);
        assert_eq!(diagnostics["resolved_execution"]["device"], "cpu");
        assert_eq!(
            diagnostics["resolved_execution"]["native_backend"],
            "native_cpu"
        );
        assert_eq!(
            diagnostics["resolved_execution"]["reference_or_production"],
            "production"
        );
        assert_eq!(
            diagnostics["spectral"]["spectral_scalar_mode"],
            "real_split"
        );
        assert_eq!(
            diagnostics["spectral"]["spectral_pencil_kind"],
            "real_frequency_rotated"
        );
        assert_eq!(
            diagnostics["spectral"]["target_representation"],
            "tau=omega_target"
        );
        assert_eq!(diagnostics["spectral"]["tau_rad_per_s"], 2.5e10);
        assert!(diagnostics["spectral"]
            .get("sigma_imag_rad_per_s")
            .is_none());
        assert_eq!(diagnostics["boundary_gauge"]["eta_row_present"], true);
        assert_eq!(diagnostics["block_residuals"]["eps_full"], 7.0e-10);
        assert_eq!(diagnostics["block_residuals"]["certified"], true);
        let metrics = native_poisson_airbox_k0_metrics_from_result_json(
            &diagnostics.to_string(),
            NativePoissonAirboxK0MetricsInput {
                mesh_resolution_m: 10.0e-9,
                airbox_size_m: 400.0e-9,
                magnetic_pair_count: 12,
                airbox_pair_count: 20,
                effective_magnetisation_a_per_m: 800_000.0,
            },
        )
        .expect("normalized solver diagnostics must retain K0 periodic-airbox metrics");
        assert_eq!(metrics.augmented_phi_dof_count, 9);
    }

    #[test]
    fn native_poisson_airbox_gpu_contract_publishes_real_split_schur_metadata() {
        let plan = minimal_native_modal_plan();
        let diagnostics_raw = serde_json::json!({
            "status": "ok",
            "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
            "assembly_kind": "mfem_weak_form_shared_domain",
            "demag_kind": "periodic_airbox_k0",
            "eigensolver_operator_kind": "materialized_schur_cuda",
            "petsc_matrix_type": "seqaijcusparse",
            "petsc_vector_type": "seqcuda",
            "slepc_basis_vector_type": "seqcuda",
            "shift_pc_type": "ilu",
            "gpu_device_resident_modal_eigensolver": true,
            "persistent_solver_context": true,
            "full_residual_certified": true,
            "residual_tolerance": 1.0e-8,
            "metrics": {
                "magnetic_block_backward_error": 1.0e-10,
                "poisson_block_backward_error": 2.0e-10,
                "gauge_constraint_backward_error": 0.0,
            },
            "executed_subwindows": [
                {
                    "subwindow_index": 0,
                    "shift_frequency_hz": 1.0e9,
                    "status": "ok",
                    "converged_eigenpair_count": 2,
                    "accepted_mode_count": 1,
                    "accepted_frequencies_hz": [1.0e9]
                },
                {
                    "subwindow_index": 1,
                    "shift_frequency_hz": 2.0e9,
                    "status": "failed",
                    "converged_eigenpair_count": 1,
                    "accepted_mode_count": 0
                }
            ],
        })
        .to_string();
        let result_raw = serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
            "demag_kind": "periodic_airbox_k0",
            "accepted_mode_count": 1,
            "q_dof_count": 56,
            "phi_dof_count": 52,
            "augmented_phi_dof_count": 52,
            "frequency_hz": 1.95e9,
            "omega_rad_s": std::f64::consts::TAU * 1.95e9,
        })
        .to_string();

        let diagnostics = native_solver_diagnostics_json(
            &plan,
            &diagnostics_raw,
            Some(&result_raw),
            Some(&native_fem::measured_modal_gpu_attestation_fixture()),
        )
        .expect("native GPU PA-E2 diagnostics should be normalized");

        assert_eq!(
            diagnostics["solver_model"],
            "k0_poisson_airbox_gpu_petsc_slepc"
        );
        assert_eq!(
            diagnostics["resolved_solver_family"],
            "device_resident_arnoldi_shift_invert"
        );
        assert_eq!(diagnostics["algebraic_form"], "schur_reduced_descriptor");
        assert_eq!(
            diagnostics["matrix_equation"],
            "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q"
        );
        assert_eq!(diagnostics["spectral_transform"], "shift_invert");
        assert_eq!(
            diagnostics["spectral"]["spectral_scalar_mode"],
            "real_split"
        );
        assert_eq!(
            diagnostics["requested_execution"]["preconditioner"],
            "shifted_schur_device"
        );
        assert_eq!(diagnostics["scalable_selected_spectrum"], true);
        assert_eq!(
            diagnostics["requested_window_hz"],
            serde_json::json!([1.0e8, 5.0e9])
        );
        assert_eq!(
            diagnostics["resolved_search_window_hz"],
            serde_json::json!([1.0e8, 5.0e9])
        );
        assert_eq!(
            diagnostics["window_completeness"]["status"],
            "not_certified"
        );
        assert_eq!(diagnostics["subwindows"][0]["subwindow_index"], 0);
        assert_eq!(
            diagnostics["subwindows"][0]["accepted_frequencies_hz"],
            serde_json::json!([1.0e9])
        );
        assert_eq!(diagnostics["subwindows"][1]["status"], "solve_error");
        assert_eq!(diagnostics["subwindows"][1]["candidate_mode_count"], 0);
        assert_eq!(
            diagnostics["subwindows"][1]["accepted_frequencies_hz"],
            serde_json::json!([])
        );
    }

    #[test]
    fn native_poisson_airbox_gpu_adapter_without_attestation_fails_closed() {
        let plan = minimal_native_modal_plan();
        let diagnostics_raw = serde_json::json!({
            "status": "ok",
            "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
            "assembly_kind": "mfem_weak_form_shared_domain",
        })
        .to_string();

        let error = native_solver_diagnostics_json(&plan, &diagnostics_raw, None, None)
            .expect_err("adapter text must not create a GPU execution claim");
        assert_eq!(error.message, "k0_poisson_airbox_gpu_attestation_missing");
    }

    #[test]
    fn native_production_poisson_airbox_diagnostics_reject_missing_boundary_contract() {
        let plan = minimal_native_modal_plan();
        let diagnostics_raw = serde_json::json!({
            "status": "ok",
            "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
            "assembly_kind": "mfem_weak_form_shared_domain",
            "production_implication": true,
            "full_residual_certified": true,
            "residual_tolerance": 1.0e-8,
            "metrics": {
                "magnetic_block_backward_error": 1.0e-10,
                "poisson_block_backward_error": 2.0e-10,
                "gauge_constraint_backward_error": 0.0,
            },
        })
        .to_string();

        let error = native_solver_diagnostics_json(&plan, &diagnostics_raw, None, None)
            .expect_err("production diagnostics must not default missing boundary metadata");
        assert!(error.message.contains("outer_boundary_kind"));
    }

    #[test]
    fn native_poisson_airbox_top_level_accepted_mode_count_is_preserved() {
        let plan = minimal_native_modal_plan();
        let diagnostics_raw = serde_json::json!({
            "resolved_solver_family": "shift_invert",
            "solver_model": "reference_full_2x2_tangent",
            "spectral_transform": "shift_invert",
        })
        .to_string();
        let result_raw = serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_cpu_schur_slepc",
            "accepted_mode_count": 3,
        })
        .to_string();

        let diagnostics =
            native_solver_diagnostics_json(&plan, &diagnostics_raw, Some(&result_raw), None)
                .expect("native Schur diagnostics should be normalized");

        assert_eq!(diagnostics["accepted_mode_count"], 3);
    }

    #[test]
    fn native_poisson_airbox_result_maps_to_k0_kittel_metrics() {
        let raw = serde_json::json!({
            "schema_version": "frequency_domain_modal_result.v1",
            "study_product": "modal_eigen",
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "demag_kind": "periodic_airbox_k0",
            "accepted_mode_count": 1,
            "q_dof_count": 2,
            "phi_dof_count": 4,
            "augmented_phi_dof_count": 5,
            "frequency_hz": 2.1e9,
            "omega_rad_s": std::f64::consts::TAU * 2.1e9,
            "poisson_constraint_relative_residual": 2.0e-11,
            "relative_reference_frequency_error": 4.0e-3,
        })
        .to_string();
        let metrics = native_poisson_airbox_k0_metrics_from_result_json(
            &raw,
            NativePoissonAirboxK0MetricsInput {
                mesh_resolution_m: 10.0e-9,
                airbox_size_m: 400.0e-9,
                magnetic_pair_count: 12,
                airbox_pair_count: 20,
                effective_magnetisation_a_per_m: 800_000.0,
            },
        )
        .expect("PA-E2 result JSON should map to K0-3 artifact metrics");

        assert_eq!(metrics.phi_dof_count, 4);
        assert_eq!(metrics.augmented_phi_dof_count, 5);
        assert_eq!(metrics.magnetic_pair_count, 12);
        assert_eq!(metrics.airbox_pair_count, 20);
        assert_eq!(metrics.effective_magnetisation_a_per_m, 800_000.0);
        assert_eq!(metrics.poisson_constraint_relative_residual, 2.0e-11);
        assert_eq!(metrics.relative_kittel_frequency_error, 4.0e-3);
    }

    #[test]
    fn native_poisson_airbox_metrics_reject_wrong_solver_adapter() {
        let raw = serde_json::json!({
            "schema_version": "frequency_domain_modal_result.v1",
            "solver_adapter": "slepc_modal_eigen",
            "demag_kind": "periodic_airbox_k0",
            "phi_dof_count": 4,
            "augmented_phi_dof_count": 5,
            "poisson_constraint_relative_residual": 0.0,
            "relative_reference_frequency_error": 0.0,
        })
        .to_string();
        let err = native_poisson_airbox_k0_metrics_from_result_json(
            &raw,
            NativePoissonAirboxK0MetricsInput {
                mesh_resolution_m: 10.0e-9,
                airbox_size_m: 400.0e-9,
                magnetic_pair_count: 12,
                airbox_pair_count: 20,
                effective_magnetisation_a_per_m: 800_000.0,
            },
        )
        .expect_err("generic modal JSON must not populate periodic-airbox metrics");

        assert!(err.message.contains("solver_adapter"));
    }

    #[test]
    fn native_poisson_airbox_result_without_modes_is_rejected() {
        let plan = minimal_native_modal_plan();
        let omega = std::f64::consts::TAU * 4.0e9;
        let raw = serde_json::json!({
            "schema_version": "frequency_domain_modal_result.v1",
            "study_product": "modal_eigen",
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "demag_kind": "periodic_airbox_k0",
            "accepted_mode_count": 1,
            "q_dof_count": 16,
            "phi_dof_count": 28,
            "augmented_phi_dof_count": 29,
            "frequency_hz": 4.0e9,
            "omega_rad_s": omega,
            "poisson_constraint_relative_residual": 2.0e-15,
            "relative_reference_frequency_error": 0.0,
        })
        .to_string();
        let stiffness = DMatrix::<f64>::zeros(4, 4);
        let mass = DMatrix::<f64>::identity(4, 4);
        let gyrotropic = vec![0.0; 16];

        let error = native_modal_modes_from_result_json(
            &plan,
            &raw,
            Some((&stiffness, &gyrotropic, &mass)),
            None,
        )
        .expect_err("PA-E2 scalar result must not fabricate a modal vector");
        assert!(error.message.contains("missing complete modes[]"));
    }

    #[test]
    fn native_poisson_airbox_modes_use_q_payload_and_certified_residuals() {
        let plan = minimal_native_modal_plan();
        let omega = std::f64::consts::TAU * 4.0e9;
        let raw = serde_json::json!({
            "schema_version": "frequency_domain_modal_result.v1",
            "study_product": "modal_eigen",
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "demag_kind": "periodic_airbox_k0",
            "modes": [{
                "mode_q_real": [1.0, 0.0, 0.0, 0.0],
                "mode_q_imag": [0.0, 1.0, 0.0, 0.0],
                "mode_phi_real": [2.0, 3.0],
                "mode_phi_imag": [4.0, 5.0],
                "eigenvalue_real": 0.0,
                "eigenvalue_imag": omega,
                "omega_rad_s": omega,
                "frequency_hz": 4.0e9,
                "relative_residual": 2.0e-12,
                "full_residual_reconstruction_relative_error": 3.0e-12,
            }]
        })
        .to_string();
        let stiffness = DMatrix::<f64>::identity(4, 4);
        let mass = DMatrix::<f64>::identity(4, 4);
        let gyrotropic = vec![0.0; 16];

        let modes = native_modal_modes_from_result_json(
            &plan,
            &raw,
            Some((&stiffness, &gyrotropic, &mass)),
            None,
        )
        .expect("complete PA-E2 q mode payload should be accepted");
        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].vector.len(), 4);
        assert_eq!(modes[0].frequency_hz, 4.0e9);
        assert_eq!(modes[0].residual_relative_l2, 2.0e-12);
        assert!(modes[0].vector.iter().any(|value| value.norm() > 0.0));
        assert_eq!(modes[0].q_vector.len(), 4);
        assert_eq!(modes[0].phi_vector.len(), 2);
        assert_eq!(modes[0].cluster_id, 0);
        assert_eq!(modes[0].block_residual_q, 3.0e-12);
        assert_eq!(modes[0].block_residual_phi, 0.0);
        let normalization = 2.0_f64.sqrt();
        assert_eq!(
            modes[0].phi_vector[0],
            Complex64::new(2.0 / normalization, 4.0 / normalization)
        );
    }

    #[test]
    fn native_shared_domain_modes_require_phi_and_block_residuals() {
        let plan = minimal_native_modal_plan();
        let omega = std::f64::consts::TAU * 4.0e9;
        let mut mode = serde_json::json!({
            "mode_q_real": [1.0, 0.0, 0.0, 0.0],
            "mode_q_imag": [0.0, 1.0, 0.0, 0.0],
            "mode_phi_real": [2.0, 3.0],
            "mode_phi_imag": [4.0, 5.0],
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": omega,
            "omega_rad_s": omega,
            "frequency_hz": 4.0e9,
            "relative_residual": 2.0e-12,
            "full_residual_reconstruction_relative_error": 3.0e-12,
        });
        let mass = DMatrix::<f64>::identity(4, 4);
        let active_nodes = [0_usize, 1_usize];
        let magnetic_classes = [0_u32, 1_u32];
        let context = SharedDomainModeContext {
            reduced_tangent_mass: &mass,
            active_nodes: &active_nodes,
            magnetic_classes: &magnetic_classes,
            magnetic_class_count: 2,
        };
        let error = native_poisson_airbox_mode_from_json(&plan, &mode, &mass, Some(&context))
            .expect_err("shared-domain mode must include certified block residuals");
        assert!(error.message.contains("magnetic_block_backward_error"));

        mode["magnetic_block_backward_error"] = serde_json::json!(3.0e-12);
        mode["poisson_block_backward_error"] = serde_json::json!(4.0e-12);
        mode["gauge_constraint_backward_error"] = serde_json::json!(0.0);
        let accepted = native_poisson_airbox_mode_from_json(&plan, &mode, &mass, Some(&context))
            .expect("complete shared-domain mode should be accepted");
        assert_eq!(accepted.block_residual_q, 3.0e-12);
        assert_eq!(accepted.block_residual_phi, 4.0e-12);
        assert_eq!(accepted.block_residual_gauge, 0.0);
    }

    #[test]
    fn native_cpu_modal_window_accepts_explicit_gamma_single_k() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });

        assert!(
            native_cpu_modal_window_enabled(&plan),
            "explicit gamma-point single-k sampling must not demote the production CPU window path"
        );
    }

    #[test]
    fn shared_domain_modal_scope_requires_uniform_accepted_equilibrium() {
        let plan = minimal_native_modal_plan();
        let topology = MeshTopology::from_ir(&plan.mesh).expect("minimal FEM mesh is valid");
        let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
        let mut equilibrium = plan.equilibrium_magnetization.clone();
        equilibrium[1] = [0.0, 1.0, 0.0];
        let error =
            validate_shared_domain_modal_scope(&plan, &topology, &equilibrium, &observables)
                .expect_err(
                    "nonuniform equilibrium must remain outside the first production scope",
                );
        assert!(error.message.contains("uniform normalized equilibrium"));
    }

    #[test]
    fn shared_domain_modal_scope_rejects_uncertified_local_tangent_terms() {
        let mut plan = minimal_native_modal_plan();
        plan.material.uniaxial_anisotropy = Some(1.0e3);
        let topology = MeshTopology::from_ir(&plan.mesh).expect("minimal FEM mesh is valid");
        let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
        let error = validate_shared_domain_modal_scope(
            &plan,
            &topology,
            &plan.equilibrium_magnetization,
            &observables,
        )
        .expect_err("uncertified anisotropy tangent must be rejected");
        assert!(error.message.contains("anisotropy and DMI tangent terms"));
    }

    #[test]
    fn native_cpu_modal_window_accepts_k0_periodic_airbox_with_v6_producer() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        add_minimal_shared_domain_periodic_airbox(&mut plan);
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        assert!(native_cpu_modal_window_enabled(&plan));
        assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
    }

    #[test]
    fn native_cpu_modal_window_does_not_require_kittel_validation_metadata() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 2.0e9,
        };
        add_minimal_shared_domain_periodic_airbox(&mut plan);
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });

        assert!(
            plan.k0_kittel_validation.is_none(),
            "this routing test must not carry an analytical Kittel validator"
        );
        assert!(!native_cpu_modal_window_enabled(&plan));
        assert_eq!(
            native_cpu_modal_window_rejection_reason(&plan),
            Some("production_cpu_modal_periodic_airbox_k0_payload_missing")
        );
    }

    #[test]
    fn native_gpu_k0_modal_selection_does_not_require_kittel_validation_metadata() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = false;
        plan.enable_demag = false;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });

        assert!(plan.k0_kittel_validation.is_none());
        assert!(
            native_gpu_k0_kittel_modal_supported(&plan),
            "physical no-demag K0 GPU selection must not depend on analytical validation metadata"
        );
    }

    #[test]
    fn native_gpu_k0_modal_selection_rejects_nonzero_k_without_kittel_oracle() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = false;
        plan.enable_demag = false;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });

        assert!(!native_gpu_k0_kittel_modal_supported(&plan));
    }

    #[test]
    fn shared_domain_builder_rejects_missing_accepted_linearization_state() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 2.0e9,
        };
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: vec!["magnetic".to_string(), "airbox".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
            [3.0, 0.0, 0.0],
            [3.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
        ];
        plan.mesh.set_tet4_cells(vec![
            [0, 1, 2, 3],
            [3, 5, 4, 0],
            [6, 7, 8, 9],
            [9, 11, 10, 6],
        ]);
        plan.mesh.element_markers = vec![1, 1, 0, 0];
        plan.mesh
            .set_tri3_facets(vec![[0, 1, 2], [3, 5, 4], [6, 7, 8], [9, 11, 10]]);
        plan.mesh.boundary_markers = vec![10, 11, 20, 21];
        plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; 12];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "magnetic".to_string(),
                node_a: 0,
                node_b: 3,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "magnetic".to_string(),
                node_a: 1,
                node_b: 4,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "magnetic".to_string(),
                node_a: 2,
                node_b: 5,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "airbox".to_string(),
                node_a: 6,
                node_b: 9,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "airbox".to_string(),
                node_a: 7,
                node_b: 10,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "airbox".to_string(),
                node_a: 8,
                node_b: 11,
            },
        ];
        plan.mesh.periodic_boundary_pairs = vec![
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "magnetic".to_string(),
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                source_marker: None,
                destination_marker: None,
                tolerance: None,
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            },
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "airbox".to_string(),
                marker_a: 20,
                marker_b: 21,
                translation: Some([1.0, 0.0, 0.0]),
                source_marker: None,
                destination_marker: None,
                tolerance: None,
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 0,
            bc_kind: Some("pure_neumann".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });

        let topology = MeshTopology::from_ir(&plan.mesh).expect("test mesh is valid");
        let reduction =
            build_reduction_map(&topology, &plan.spin_wave_bc, plan.k_sampling.as_ref())
                .expect("periodic reduction should be valid");
        assert!(
            reduction.active_nodes.len()
                < topology
                    .magnetic_node_volumes
                    .iter()
                    .filter(|volume| **volume > 0.0)
                    .count(),
            "the fixture must actually reduce a magnetic periodic class"
        );
        let bases = tangent_bases(&plan.equilibrium_magnetization);
        let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
        let (reduced_stiffness, _) = assemble_full_2x2_operator_real(
            &plan,
            &topology,
            &reduction,
            &observables,
            &plan.equilibrium_magnetization,
            &bases,
        );
        assert_eq!(
            reduced_stiffness.nrows(),
            2 * reduction.active_nodes.len(),
            "the pre-existing modal operator is class-reduced and must not be sent as A_qq"
        );

        let rejection = build_native_shared_domain_modal_problem(
            &plan,
            &topology,
            &plan.equilibrium_magnetization,
            &observables,
            None,
            0,
        )
        .expect_err("shared-domain K0 must require an accepted linearization state");
        assert!(
            rejection
                .message
                .contains("requires an accepted linearization state"),
            "missing accepted state must fail closed before descriptor construction: {}",
            rejection.message
        );
    }

    #[test]
    fn shared_domain_builder_rejects_implicit_region_markers_before_native_assembly() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 2.0e9,
        };
        add_minimal_shared_domain_periodic_airbox(&mut plan);
        plan.mesh.element_markers.fill(1);

        let topology = MeshTopology::from_ir(&plan.mesh).expect("test mesh is valid");
        let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
        let rejection = build_native_shared_domain_modal_problem(
            &plan,
            &topology,
            &plan.equilibrium_magnetization,
            &observables,
            None,
            0,
        )
        .expect_err("shared-domain K0 must require explicit magnetic/airbox markers");
        assert!(
            rejection
                .message
                .contains("k0_poisson_airbox_requires_explicit_region_markers"),
            "implicit region markers must fail closed before native assembly: {}",
            rejection.message
        );
    }

    #[test]
    fn native_gpu_shared_domain_requires_operator_demag_flag() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 2.0e9,
        };
        add_minimal_shared_domain_periodic_airbox(&mut plan);

        assert!(native_gpu_shared_domain_modal_supported(&plan));
        plan.operator.include_demag = false;
        assert!(!native_gpu_shared_domain_modal_supported(&plan));
    }

    #[test]
    fn shared_domain_k0_v6_producer_unlocks_native_magnetic_gate() {
        let mut plan = minimal_native_modal_plan();
        add_minimal_shared_domain_periodic_airbox(&mut plan);
        assert!(native_shared_domain_magnetic_assembly_available(&plan));

        let mut stale_part = plan.clone();
        stale_part.mesh_parts[0].id = "part:stale".to_string();
        assert!(!native_shared_domain_magnetic_assembly_available(
            &stale_part
        ));

        let mut stale_certificate_input = plan;
        stale_certificate_input.mesh.periodic_node_pairs.pop();
        assert!(!native_shared_domain_magnetic_assembly_available(
            &stale_certificate_input
        ));
    }

    #[test]
    fn shared_domain_k0_diagnostics_do_not_publish_stale_producer_rejection() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 2.0e9,
        };
        add_minimal_shared_domain_periodic_airbox(&mut plan);

        let diagnostics = modal_solver_diagnostics_json(&plan, "cpu_full_2x2_phase_reduced", 1);
        assert!(diagnostics.get("production_cpu_rejection_reason").is_none());
        assert!(diagnostics.get("runtime_capability_status").is_none());
        assert!(diagnostics.get("runtime_capability_reason").is_none());
    }

    #[test]
    fn zero_k_path_is_gamma_for_shared_domain_modal_dispatch() {
        let zero_path = KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR::gamma(),
                fullmag_ir::KPointIR {
                    label: Some("same-gamma".to_string()),
                    k_vector: [0.0, -0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        };
        assert!(is_gamma_k_sampling(Some(&zero_path)));

        let nonzero_path = KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR::gamma(),
                fullmag_ir::KPointIR {
                    label: Some("finite-k".to_string()),
                    k_vector: [1.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        };
        assert!(!is_gamma_k_sampling(Some(&nonzero_path)));
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_creates_full_coupled_poisson_airbox_payload() {
        let mut plan = minimal_native_modal_plan();
        plan.target = fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 1.25e9,
        };
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
        ];
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("PA-E4b builder should accept a K0-3 periodic-airbox plan")
            .expect("K0-3 periodic-airbox plan should produce a payload");
        let borrowed = payload.borrowed();

        assert_eq!(borrowed.q_dof_count, 2);
        assert_eq!(borrowed.phi_dof_count, 2);
        assert_eq!(
            borrowed.periodic_mesh_certificate_schema,
            "periodic_mesh_certificate.v6"
        );
        assert_eq!(borrowed.magnetic_pair_count, 1);
        assert_eq!(borrowed.airbox_pair_count, 1);
        assert_eq!(borrowed.phi_mean_weights, &[0.5, 0.5]);
        assert!(
            borrowed.a_qphi_csr.values.iter().any(|value| *value != 0.0),
            "PA-E4b payload must include nonzero magnetic feedback from phi"
        );
        assert!(
            borrowed.a_phiq_csr.values.iter().any(|value| *value != 0.0),
            "PA-E4b payload must include nonzero Poisson source from q"
        );
        assert_eq!(borrowed.target_frequency_hz, 1.25e9);
        assert_eq!(
            borrowed.expected_reference_frequency_hz, 0.0,
            "analytical Kittel reference must not enter the native solve request"
        );
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_scales_payload_dimensions_with_pair_maps() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
            [3.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
        ];
        plan.mesh.set_tet4_cells(vec![
            [0, 1, 2, 3],
            [1, 4, 2, 5],
            [6, 7, 8, 9],
            [7, 10, 8, 11],
        ]);
        plan.mesh.element_markers = vec![1, 1, 0, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx0".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx1".to_string(),
                node_a: 2,
                node_b: 4,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax0".to_string(),
                node_a: 6,
                node_b: 7,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax1".to_string(),
                node_a: 8,
                node_b: 10,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("PA-E4b builder should accept a K0-3 periodic-airbox plan")
            .expect("K0-3 periodic-airbox plan should produce a payload");
        let borrowed = payload.borrowed();

        assert_eq!(borrowed.magnetic_pair_count, 2);
        assert_eq!(borrowed.airbox_pair_count, 2);
        assert_eq!(borrowed.q_dof_count, 4);
        assert_eq!(borrowed.phi_dof_count, 4);
        assert_eq!(borrowed.phi_mean_weights, &[0.25, 0.25, 0.25, 0.25]);
        assert_eq!(borrowed.a_qq_csr.row_count, borrowed.q_dof_count);
        assert_eq!(borrowed.a_qphi_csr.column_count, borrowed.phi_dof_count);
        assert_eq!(borrowed.a_phiq_csr.row_count, borrowed.phi_dof_count);
        assert_eq!(borrowed.a_phiphi_csr.row_count, borrowed.phi_dof_count);
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_weights_poisson_block_by_airbox_pair_geometry() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
        ];
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let short_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("short airbox pair should be valid")
            .expect("short airbox pair should produce a payload");
        let short_values = short_payload.a_phiphi_csr.values.clone();

        plan.mesh.nodes[5] = [5.0, 0.0, 0.0];
        let long_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("long airbox pair should be valid")
            .expect("long airbox pair should produce a payload");

        assert_ne!(
            short_values, long_payload.a_phiphi_csr.values,
            "Poisson block weights must depend on airbox pair geometry, not only pair count"
        );
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_weights_phi_gauge_by_airbox_pair_geometry() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
            [4.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
        ];
        plan.mesh.set_tet4_cells(vec![
            [0, 1, 2, 3],
            [1, 4, 2, 5],
            [6, 7, 8, 9],
            [7, 10, 8, 11],
        ]);
        plan.mesh.element_markers = vec![1, 1, 0, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx0".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx1".to_string(),
                node_a: 2,
                node_b: 4,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax0".to_string(),
                node_a: 6,
                node_b: 7,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax1".to_string(),
                node_a: 8,
                node_b: 10,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("PA-E4b builder should accept unequal airbox pair lengths")
            .expect("PA-E4b builder should produce payload");
        let weights = payload.phi_mean_weights;
        let weight_sum = weights.iter().sum::<f64>();

        assert!(
            (weight_sum - 1.0).abs() < 1.0e-12,
            "phi gauge weights must be normalized, got {weights:?}"
        );
        assert!(
            weights[2] > weights[0],
            "longer airbox pair should carry larger mean-zero gauge weight, got {weights:?}"
        );
        assert!(
            (weights[0] - weights[1]).abs() < 1.0e-12
                && (weights[2] - weights[3]).abs() < 1.0e-12,
            "two phi DOFs belonging to one airbox pair should share that pair weight, got {weights:?}"
        );
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_weights_mass_block_by_magnetic_element_volume() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [10.0, 0.0, 0.0],
            [12.0, 0.0, 0.0],
            [10.0, 2.0, 0.0],
            [10.0, 0.0, 2.0],
            [20.0, 0.0, 0.0],
            [21.0, 0.0, 0.0],
            [20.0, 1.0, 0.0],
            [20.0, 0.0, 1.0],
        ];
        plan.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]);
        plan.mesh.element_markers = vec![1, 1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx0".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx1".to_string(),
                node_a: 4,
                node_b: 5,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax0".to_string(),
                node_a: 8,
                node_b: 9,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("PA-E4b builder should accept different magnetic volumes")
            .expect("PA-E4b builder should produce payload");
        let b_values = &payload.b_qq_csr.values;

        assert_eq!(payload.q_dof_count, 4);
        assert_eq!(payload.b_qq_csr.row_count, 4);
        assert_eq!(payload.b_qq_csr.column_count, 4);
        assert!(
            (b_values[0] - b_values[1]).abs() < 1.0e-18,
            "same magnetic pair tangent components must share the same mass"
        );
        assert!(
            (b_values[2] - b_values[3]).abs() < 1.0e-18,
            "same magnetic pair tangent components must share the same mass"
        );
        assert!(
            (b_values[2] - b_values[0]).abs() > b_values[0].abs() * 1.0,
            "B_qq masses must reflect different magnetic element volumes, got {b_values:?}"
        );
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_mass_weights_llg_block_consistently() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.external_field = Some([50.0e-3 / crate::MU0, 0.0, 0.0]);
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [20.0e-9, 0.0, 0.0],
            [0.0, 20.0e-9, 0.0],
            [0.0, 0.0, 10.0e-9],
            [30.0e-9, 0.0, 0.0],
            [50.0e-9, 0.0, 0.0],
            [30.0e-9, 20.0e-9, 0.0],
            [30.0e-9, 0.0, 20.0e-9],
        ];
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("PA-E4b builder should accept nanometer-scale mesh")
            .expect("PA-E4b builder should produce payload");
        let a_values = &payload.a_qq_csr.values;
        let b_values = &payload.b_qq_csr.values;
        let expected_omega = plan.gyromagnetic_ratio * vector_norm(plan.external_field.unwrap());

        let observed_omega = a_values[0].abs() / b_values[0];
        assert!(
            (observed_omega - expected_omega).abs() <= expected_omega * 1.0e-12,
            "A_qq/B_qq must preserve gamma*H0 scaling, got {observed_omega} expected {expected_omega}"
        );

        let max_phiq = payload
            .a_phiq_csr
            .values
            .iter()
            .map(|value| value.abs())
            .fold(0.0_f64, f64::max);
        let max_phiphi = payload
            .a_phiphi_csr
            .values
            .iter()
            .map(|value| value.abs())
            .fold(0.0_f64, f64::max);
        assert!(
            (0.05..=20.0).contains(&max_phiq),
            "A_phiq must be dimensionless-normalized for the mean-zero Poisson block, got max {max_phiq}"
        );
        assert!(
            (0.05..=40.0).contains(&max_phiphi),
            "A_phiphi must be dimensionless-normalized for nanometer meshes, got max {max_phiphi}"
        );
    }

    fn csr_value(matrix: &OwnedModalEigenCsrMatrix, row: usize, column: usize) -> f64 {
        let row_begin = matrix.row_offsets[row] as usize;
        let row_end = matrix.row_offsets[row + 1] as usize;
        for entry in row_begin..row_end {
            if matrix.column_indices[entry] as usize == column {
                return matrix.values[entry];
            }
        }
        0.0
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_calibrates_schur_demag_to_kittel_meff() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [20.0e-9, 0.0, 0.0],
            [0.0, 20.0e-9, 0.0],
            [0.0, 0.0, 10.0e-9],
            [30.0e-9, 0.0, 0.0],
            [50.0e-9, 0.0, 0.0],
            [30.0e-9, 20.0e-9, 0.0],
            [30.0e-9, 0.0, 20.0e-9],
        ];
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("PA-E4b builder should accept nanometer-scale mesh")
            .expect("PA-E4b builder should produce payload");
        assert_eq!(payload.q_dof_count, 2);
        assert_eq!(payload.phi_dof_count, 2);

        let source0 = csr_value(&payload.a_phiq_csr, 0, 1);
        let source1 = csr_value(&payload.a_phiq_csr, 1, 1);
        let p00 = csr_value(&payload.a_phiphi_csr, 0, 0);
        let p01 = csr_value(&payload.a_phiphi_csr, 0, 1);
        assert!(
            (source0 + source1).abs() < 1.0e-12,
            "single-pair Poisson source must be mean-zero, got [{source0}, {source1}]"
        );
        assert!(
            (p00 + p01).abs() < 1.0e-12,
            "single-pair Poisson row must be singular before gauge, got [{p00}, {p01}]"
        );
        let phi0_for_q1 = -source0 / (2.0 * p00);
        let phi1_for_q1 = -source1 / (2.0 * p00);
        let demag_feedback = csr_value(&payload.a_qphi_csr, 0, 0) * phi0_for_q1
            + csr_value(&payload.a_qphi_csr, 0, 1) * phi1_for_q1;
        let magnetic_mass = csr_value(&payload.b_qq_csr, 0, 0);
        let expected_feedback = -plan.gyromagnetic_ratio
            * plan
                .k0_kittel_validation
                .as_ref()
                .unwrap()
                .material
                .effective_magnetisation
                .unwrap()
            * magnetic_mass;

        assert!(
            (demag_feedback - expected_feedback).abs() <= expected_feedback.abs() * 1.0e-12,
            "Schur demag feedback must encode gamma*M_eff once, got {demag_feedback} expected {expected_feedback}"
        );
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_weights_demag_coupling_by_mesh_geometry() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
        ];
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "mx".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "ax".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let short_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("short airbox pair should be valid")
            .expect("short airbox pair should produce a payload");
        let short_a_qphi = short_payload.a_qphi_csr.values.clone();
        let short_a_phiq = short_payload.a_phiq_csr.values.clone();

        plan.mesh.nodes[5] = [5.0, 0.0, 0.0];
        let long_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect("long airbox pair should be valid")
            .expect("long airbox pair should produce a payload");

        assert_ne!(
            short_a_qphi, long_payload.a_qphi_csr.values,
            "A_qphi coupling must depend on mesh geometry, not only H0/M_eff and pair count"
        );
        assert_ne!(
            short_a_phiq, long_payload.a_phiq_csr.values,
            "A_phiq coupling must depend on mesh geometry, not only pair count"
        );
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_rejects_missing_real_periodic_airbox_pair_maps() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let err = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect_err("PA-E4b payload must require real magnetic and airbox pair maps");

        assert!(
            err.message
                .contains("requires positive magnetic and airbox periodic pair counts"),
            "unexpected error: {}",
            err.message
        );
        assert!(
            !native_cpu_modal_window_enabled(&plan),
            "K0-3 periodic_airbox_k0 must not enter native modal production without real magnetic and airbox pair maps"
        );
    }

    #[test]
    fn pa_e4b_k0_kittel_builder_rejects_missing_airbox_geometry_metadata() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
        ];
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        plan.air_box_config = None;
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });

        let err = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
            .expect_err("PA-E4b payload must require real airbox geometry metadata");

        assert!(
            err.message
                .contains("requires positive air_box_config.factor and mesh extent"),
            "unexpected error: {}",
            err.message
        );
        assert!(
            !native_cpu_modal_window_enabled(&plan),
            "K0-3 periodic_airbox_k0 must not enter native modal production without airbox geometry metadata"
        );
    }

    #[test]
    fn native_cpu_modal_window_rejects_nonzero_single_k_until_floquet_operator_exists() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });

        assert!(
            !native_cpu_modal_window_enabled(&plan),
            "nonzero-k modal production still requires a real Floquet/Bloch operator path"
        );
    }

    #[test]
    fn native_cpu_modal_window_accepts_nonzero_floquet_single_k_with_bloch_payload_path() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        add_x_floquet_pair_to_plan(&mut plan);

        assert!(
            native_cpu_modal_window_enabled(&plan),
            "nonzero-k Floquet Full2x2 frequency-window requests should use the native Bloch/Floquet payload path"
        );
        assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
    }

    #[test]
    fn reference_modal_diagnostics_name_nonzero_k_production_cpu_rejection() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });

        let diagnostics =
            modal_solver_diagnostics_json(&plan, "cpu_full_2x2_phase_reduced_floquet", 1);

        assert_eq!(
            diagnostics
                .get("production_cpu_rejection_reason")
                .and_then(|value| value.as_str()),
            Some("production_cpu_modal_nonzero_k_floquet_operator_missing")
        );
        assert_eq!(
            diagnostics
                .get("production_cpu_rejection_scope")
                .and_then(|value| value.as_str()),
            Some("selected_spectrum_nonzero_k_floquet_modal")
        );
        assert_eq!(
            diagnostics
                .get("required_operator_contract")
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator_with_periodic_pairs")
        );
        assert_eq!(
            diagnostics
                .get("required_operator_payload_kind")
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator")
        );
        assert_eq!(
            diagnostics
                .get("modal_periodic_pair_contract_available")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn reference_modal_diagnostics_name_dynamic_demag_k_production_cpu_rejection() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });

        let diagnostics =
            modal_solver_diagnostics_json(&plan, "cpu_full_2x2_phase_reduced_floquet", 1);

        assert_eq!(
            native_cpu_modal_window_rejection_reason(&plan),
            Some("production_cpu_modal_dynamic_demag_k_operator_missing")
        );
        assert_eq!(
            diagnostics
                .get("production_cpu_rejection_reason")
                .and_then(|value| value.as_str()),
            Some("production_cpu_modal_dynamic_demag_k_operator_missing")
        );
        assert_eq!(
            diagnostics
                .get("production_cpu_rejection_scope")
                .and_then(|value| value.as_str()),
            Some("selected_spectrum_nonzero_k_floquet_modal_dynamic_demag")
        );
        assert_eq!(
            diagnostics
                .get("required_operator_contract")
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator_with_dynamic_demag_k")
        );
        assert_eq!(
            diagnostics
                .get("required_operator_payload_kind")
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator")
        );
        assert_eq!(
            diagnostics
                .get("required_demag_payload_kind")
                .and_then(|value| value.as_str()),
            Some("dynamic_demag_k_operator")
        );
        assert_eq!(
            diagnostics
                .get("dynamic_demag_operator_source")
                .and_then(|value| value.as_str()),
            Some("missing_numeric_fem_demag_k")
        );
    }

    #[test]
    fn sparse_lowest_without_retained_modes_does_not_raise_window_error() {
        let target = fullmag_ir::EigenTargetIR::Lowest;

        reject_empty_frequency_window_result(&target, 20, 0, 0)
            .expect("lowest target does not use the frequency-window coverage diagnostic");
    }

    #[test]
    fn runner_rejects_floquet_dynamic_demag_gate() {
        let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: Some("x_faces".to_string()),
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });

        let err = reject_unsupported_floquet_dynamic_demag(&bc, true)
            .expect_err("Floquet dynamic demag must be blocked before execution");
        assert!(err
            .message
            .contains("dynamic demag for Floquet periodic FEM is not implemented yet"));
    }

    #[test]
    fn runner_allows_floquet_without_dynamic_demag_gate() {
        let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: Some("x_faces".to_string()),
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });

        reject_unsupported_floquet_dynamic_demag(&bc, false)
            .expect("Floquet phase reduction remains valid when dynamic demag is disabled");
    }

    #[test]
    fn floquet_phase_uses_minus_sign_and_boundary_translation() {
        let mesh = fullmag_ir::MeshIR {
            mesh_name: "periodic_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 2, 3], [1, 2, 3]]),
            boundary_markers: vec![10, 11],
            periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1e-12),
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            }],
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topology = MeshTopology::from_ir(&mesh).expect("valid FEM mesh");
        let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: Some("x_faces".to_string()),
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });

        let groups = phase_reduction(
            &topology,
            &bc,
            Some(&KSamplingIR::Single {
                k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
            }),
        )
        .expect("Floquet phase reduction should be built")
        .expect("Floquet BC should produce phase groups");

        let phase = groups.phases[1];
        assert!(
            phase.re.abs() < 1e-12,
            "phase should be imaginary: {phase:?}"
        );
        assert!(
            (phase.im + 1.0).abs() < 1e-12,
            "expected exp(-i*pi/2) from boundary translation, got {phase:?}"
        );
    }

    #[test]
    fn native_modal_floquet_pair_payload_uses_selected_boundary_translation() {
        let mut plan = minimal_native_modal_plan();
        plan.mesh = fullmag_ir::MeshIR {
            mesh_name: "periodic_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 2, 3], [1, 2, 3]]),
            boundary_markers: vec![10, 11],
            periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1e-12),
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            }],
            per_domain_quality: std::collections::HashMap::new(),
        };
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
        });

        let topology = MeshTopology::from_ir(&plan.mesh).expect("valid FEM mesh");
        let pairs = native_modal_floquet_periodic_pairs(&plan, &topology)
            .expect("native modal Floquet pairs should be built");

        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].pair_id, Some("x_faces"));
        assert_eq!(pairs[0].node_a, 0);
        assert_eq!(pairs[0].node_b, 1);
        assert_eq!(pairs[0].translation_m, Some([1.0, 0.0, 0.0]));
        assert_eq!(pairs[0].phase_rad, Some(-std::f64::consts::FRAC_PI_2));
    }

    #[test]
    fn bloch_floquet_dense_payload_embeds_complex_operator_as_gyrotropic_pencil() {
        let stiffness = vec![vec![Complex64::new(2.0, 0.0)]];
        let mass = vec![vec![Complex64::new(1.0, 0.0)]];

        let payload = native_bloch_floquet_dense_payload_from_complex_pair(&stiffness, &mass)
            .expect("1x1 complex operator should embed as native Bloch/Floquet payload");

        assert_eq!(payload.physical_complex_dof, 1);
        assert_eq!(payload.stiffness.nrows(), 4);
        assert_eq!(payload.stiffness.ncols(), 4);
        assert_eq!(
            payload.gyrotropic_row_major,
            vec![
                0.0, 0.0, -1.0, 0.0, //
                0.0, 0.0, 0.0, -1.0, //
                1.0, 0.0, 0.0, 0.0, //
                0.0, 1.0, 0.0, 0.0,
            ]
        );
        assert_eq!(payload.tangent_mass.nrows(), 4);
        assert_eq!(payload.tangent_mass.ncols(), 4);

        let mode = vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 1.0),
            Complex64::new(0.0, 0.0),
        ];
        let lambda = Complex64::new(0.0, 2.0);
        let (absolute, relative, linf) = gyrotropic_pencil_residual_norms(
            &payload.stiffness,
            &payload.gyrotropic_row_major,
            lambda,
            &mode,
        );

        assert!(absolute < 1.0e-12, "absolute residual={absolute}");
        assert!(relative < 1.0e-12, "relative residual={relative}");
        assert!(linf < 1.0e-12, "linf residual={linf}");
    }

    #[test]
    fn bloch_floquet_embedded_native_mode_deembeds_to_physical_complex_mode() {
        let physical_mode = vec![Complex64::new(1.0, 2.0), Complex64::new(-0.5, 0.25)];
        let real_block = vec![
            Complex64::new(physical_mode[0].re, 0.0),
            Complex64::new(physical_mode[1].re, 0.0),
            Complex64::new(physical_mode[0].im, 0.0),
            Complex64::new(physical_mode[1].im, 0.0),
        ];
        let mut embedded = real_block.clone();
        embedded.extend(real_block.iter().map(|value| Complex64::i() * *value));

        let deembedded = deembed_native_bloch_floquet_mode_vector(&embedded, physical_mode.len())
            .expect("embedded native mode should deembed to the physical complex mode");

        assert_eq!(deembedded.len(), physical_mode.len());
        for (actual, expected) in deembedded.iter().zip(physical_mode.iter()) {
            assert!(
                (*actual - *expected).norm() < 1.0e-12,
                "actual={actual:?}, expected={expected:?}"
            );
        }
    }

    #[test]
    fn native_frequency_domain_unavailable_modal_is_not_treated_as_dense_fallback() {
        let err = execute_gpu_fem_eigen(&minimal_native_modal_plan(), &[], None)
            .expect_err("explicit native modal path must not fall back to dense reference solve");
        assert!(
            err.message
                .contains("native FEM modal_eigen production path is unavailable")
                || err
                    .message
                    .contains("native FEM modal eigen solve requires the fem-native feature")
                || err
                    .message
                    .contains("native FEM modal eigen solve requires the fem-gpu feature"),
            "unexpected native modal error: {}",
            err.message
        );
        assert!(
            !err.message.contains("FEM eigen GPU solve succeeded"),
            "explicit native modal path must not report dense GPU success"
        );
        assert!(
            !err.message.contains("cuSolverDN"),
            "explicit native modal path must not expose dense GPU fallback details"
        );
        if err.message.contains("diagnostics_json=") {
            assert!(
                err.message.contains("modal_eigen"),
                "missing modal diagnostics"
            );
        }
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn cpu_full_2x2_frequency_window_uses_native_modal_artifact_path() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = None;
        plan.count = 4;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e3,
            frequency_max_hz: 5.0e6,
        };

        let run = execute_cpu_fem_eigen(
            &plan,
            &[
                OutputIR::EigenSpectrum {
                    quantity: "frequency_hz".to_string(),
                },
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0],
                },
            ],
        )
        .expect("eligible full 2x2 frequency window should use native modal production");

        let summary = run
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
            .expect("native modal path must publish eigen summary");
        let summary_json: serde_json::Value =
            serde_json::from_slice(&summary.bytes).expect("summary should be JSON");
        assert_eq!(
            summary_json
                .get("solver_backend")
                .and_then(|value| value.as_str()),
            Some("native_fem_modal_eigen")
        );
        assert_eq!(
            summary_json
                .get("solver_diagnostics")
                .and_then(|value| value.get("execution_lane"))
                .and_then(|value| value.as_str()),
            Some("production_cpu")
        );
        assert_eq!(
            summary_json
                .get("solver_diagnostics")
                .and_then(|value| value.get("solver_model"))
                .and_then(|value| value.as_str()),
            Some("slepc_multi_shift_invert_production_cpu_dense")
        );
        assert_eq!(
            summary_json
                .get("solver_kind")
                .and_then(|value| value.as_str()),
            Some("slepc_multi_shift_invert_production_cpu_dense")
        );
        assert!(
            summary_json
                .get("solver_capabilities")
                .and_then(|value| value.as_array())
                .is_some_and(|capabilities| capabilities
                    .iter()
                    .any(|value| value.as_str() == Some("shift_invert"))),
            "{}",
            summary_json
        );
        assert!(
            summary_json
                .get("solver_notes")
                .and_then(|value| value.as_str())
                .is_some_and(|notes| notes.contains("shift-invert")),
            "{}",
            summary_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn cpu_full_2x2_nonzero_floquet_window_uses_native_bloch_payload_artifact_path() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.count = 2;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
        };
        plan.external_field = Some([39_789.0, 0.0, 0.0]);
        add_x_floquet_pair_to_plan(&mut plan);

        let run = execute_cpu_fem_eigen(
            &plan,
            &[
                OutputIR::EigenSpectrum {
                    quantity: "frequency_hz".to_string(),
                },
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0],
                },
            ],
        )
        .expect(
            "eligible nonzero-k Floquet window should use native Bloch/Floquet modal production",
        );

        let summary = run
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
            .expect("native modal path must publish eigen summary");
        let summary_json: serde_json::Value =
            serde_json::from_slice(&summary.bytes).expect("summary should be JSON");
        assert_eq!(
            summary_json
                .get("solver_backend")
                .and_then(|value| value.as_str()),
            Some("native_fem_modal_eigen")
        );
        let diagnostics = summary_json
            .get("solver_diagnostics")
            .expect("native summary should carry solver diagnostics");
        assert_eq!(
            diagnostics
                .get("execution_lane")
                .and_then(|value| value.as_str()),
            Some("production_cpu")
        );
        assert_eq!(
            diagnostics
                .get("operator_diagnostics")
                .and_then(|value| value.get("payload_kind"))
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator")
        );
        assert_eq!(
            diagnostics
                .get("floquet_periodic_pair_count")
                .and_then(|value| value.as_u64()),
            Some(1)
        );
        assert_eq!(
            diagnostics
                .get("modal_periodic_pair_contract_available")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(
            diagnostics
                .get("production_cpu_rejection_reason")
                .and_then(|value| value.as_str())
                .is_none(),
            "{}",
            diagnostics
        );
    }

    #[test]
    fn native_cpu_modal_window_accepts_floquet_gamma_with_pair_payload() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
        };
        add_x_floquet_pair_to_plan(&mut plan);
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });

        assert!(
            native_cpu_modal_window_enabled(&plan),
            "Floquet gamma samples with periodic pair metadata must use the same native Bloch/Floquet payload path as nonzero-k samples so production k-paths do not mix reference and production samples"
        );
        assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn cpu_full_2x2_frequency_window_progress_and_provenance_report_shift_invert() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = None;
        plan.count = 4;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e3,
            frequency_max_hz: 5.0e6,
        };

        let mut progress_events = Vec::<FemEigenProgress>::new();
        let mut progress = |event: FemEigenProgress| {
            progress_events.push(event);
            StepAction::Continue
        };
        let run = execute_cpu_fem_eigen_with_progress(
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            }],
            &mut progress,
        )
        .expect("native full 2x2 frequency window should solve with shift-invert");

        assert!(
            progress_events
                .iter()
                .any(|event| event.phase == "solving_native_shift_invert"
                    && event.solver_kind == "slepc_multi_shift_invert_production_cpu_dense"),
            "{progress_events:?}"
        );
        assert!(
            progress_events
                .iter()
                .all(|event| event.solver_kind != "contour_interval_production_cpu_dense"),
            "{progress_events:?}"
        );
        assert_eq!(
            run.provenance.execution_engine,
            "native_fem_modal_eigen/slepc_multi_shift_invert_production_cpu_dense"
        );
    }

    #[test]
    fn equilibrium_artifact_loader_requires_certified_v7_contract() {
        let path = std::env::temp_dir().join(format!(
            "fullmag-eigen-equilibrium-v7-{}.json",
            std::process::id()
        ));
        let completion_sha256 =
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let mut artifact = serde_json::json!({
            "schema_version": "equilibrium_artifact.v7",
            "accepted_for_linearization": true,
            "acceptance_certificate": {
                "criterion": "energy",
                "metric_kind": "total_energy_plateau_range_j",
                "metric_value": 8e-13,
                "threshold": 1e-12,
                "unit": "J",
                "status": "completed",
                "converged": true,
                "stop_reason": "energy",
                "completion_sha256": completion_sha256,
            },
            "completion_sha256": completion_sha256,
            "producer_run_id": "run:eq", "mesh_signature": format!("sha256:{}", "1".repeat(64)),
            "material_signature": format!("sha256:{}", "2".repeat(64)), "physics_signature": format!("sha256:{}", "3".repeat(64)),
            "boundary_signature": format!("sha256:{}", "4".repeat(64)), "static_demag_signature": format!("sha256:{}", "5".repeat(64)),
            "m0": [[0.0, 0.0, 1.0]], "h_eff0_a_per_m": [[0.0, 0.0, 1.0]],
            "h_demag0_a_per_m": [[0.0, 0.0, 0.0]], "phi0_a": [0.0],
            "phi0_requirement": "required_for_restart_or_provenance",
            "observables": {"max_torque_Apm": 0.4, "max_torque_T": 5.026548245743669e-7, "max_torque_relative": 3.2e-5},
            "representation_integrity": {"m0_norm_tolerance": 1e-10},
            "periodic_mesh_certificate": {"schema_version": "periodic_mesh_certificate.v6", "certificate_id": "periodic_mesh_certificate.v6:cert", "content_sha256": "sha256:cert", "certificate": {"certificate_status": "accepted"}}
        });
        let content_sha256 =
            shared_domain_content_digest("equilibrium_artifact_v7", &artifact).unwrap();
        artifact["content_sha256"] = serde_json::json!(content_sha256);
        artifact["equilibrium_id"] = serde_json::json!(format!(
            "equilibrium_artifact.v7:{}",
            content_sha256.strip_prefix("sha256:").unwrap()
        ));
        std::fs::write(&path, artifact.to_string()).unwrap();
        assert_eq!(
            load_equilibrium_artifact_v7(path.to_str().unwrap(), 1)
                .unwrap()
                .m0,
            vec![[0.0, 0.0, 1.0]]
        );

        let mut invalid_cases = Vec::new();
        invalid_cases.push(serde_json::json!([[0.0, 0.0, 1.0]]));
        let mut v6 = artifact.clone();
        v6["schema_version"] = serde_json::json!("equilibrium_artifact.v6");
        invalid_cases.push(v6.clone());
        let mut missing_acceptance = artifact.clone();
        missing_acceptance
            .as_object_mut()
            .unwrap()
            .remove("acceptance_certificate");
        invalid_cases.push(missing_acceptance);
        let mut incoherent_unit = artifact.clone();
        incoherent_unit["acceptance_certificate"]["unit"] = serde_json::json!("A/m");
        invalid_cases.push(incoherent_unit);
        let mut unsatisfied = artifact.clone();
        unsatisfied["acceptance_certificate"]["metric_value"] = serde_json::json!(2e-12);
        invalid_cases.push(unsatisfied);
        let mut mismatched_completion = artifact.clone();
        mismatched_completion["completion_sha256"] =
            serde_json::json!(format!("sha256:{}", "c".repeat(64)));
        invalid_cases.push(mismatched_completion);

        for invalid in invalid_cases {
            std::fs::write(&path, invalid.to_string()).unwrap();
            assert!(load_equilibrium_artifact_v7(path.to_str().unwrap(), 1).is_err());
        }

        std::fs::write(&path, v6.to_string()).unwrap();
        let error = load_equilibrium_artifact_v7(path.to_str().unwrap(), 1).unwrap_err();
        assert!(error.message.contains(
            "equilibrium_artifact_v6_uncertified: rerun relaxation or migrate with source completion evidence"
        ));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn equilibrium_artifact_v7_loader_rejects_payload_tamper() {
        let path = std::env::temp_dir().join(format!(
            "fullmag-eigen-equilibrium-v7-tamper-{}.json",
            std::process::id()
        ));
        let completion_sha256 = format!("sha256:{}", "0".repeat(64));
        let mut artifact = serde_json::json!({
            "schema_version": "equilibrium_artifact.v7",
            "accepted_for_linearization": true,
            "acceptance_certificate": {
                "criterion": "torque", "metric_kind": "max_torque_apm",
                "metric_value": 0.4, "threshold": 0.5, "unit": "A/m",
                "status": "completed", "converged": true, "stop_reason": "torque",
                "completion_sha256": completion_sha256,
            },
            "completion_sha256": completion_sha256,
            "producer_run_id": "run:eq", "mesh_signature": format!("sha256:{}", "1".repeat(64)),
            "material_signature": format!("sha256:{}", "2".repeat(64)), "physics_signature": format!("sha256:{}", "3".repeat(64)),
            "boundary_signature": format!("sha256:{}", "4".repeat(64)), "static_demag_signature": format!("sha256:{}", "5".repeat(64)),
            "m0": [[0.0, 0.0, 1.0]], "h_eff0_a_per_m": [[0.0, 0.0, 1.0]],
            "h_demag0_a_per_m": [[0.0, 0.0, 0.0]], "phi0_a": [0.0],
            "phi0_requirement": "required_for_restart_or_provenance",
            "observables": {"max_torque_Apm": 0.4, "max_torque_T": 5.026548245743669e-7, "max_torque_relative": 3.2e-5},
            "representation_integrity": {"m0_norm_tolerance": 1e-10},
            "periodic_mesh_certificate": {"schema_version": "periodic_mesh_certificate.v6", "certificate_id": "periodic_mesh_certificate.v6:cert", "content_sha256": "sha256:cert", "certificate": {"certificate_status": "accepted"}}
        });
        let content_sha256 =
            shared_domain_content_digest("equilibrium_artifact_v7", &artifact).unwrap();
        artifact["content_sha256"] = serde_json::json!(content_sha256);
        artifact["equilibrium_id"] = serde_json::json!(format!(
            "equilibrium_artifact.v7:{}",
            content_sha256.strip_prefix("sha256:").unwrap()
        ));

        artifact["m0"] = serde_json::json!([[0.0, 1.0, 0.0]]);
        std::fs::write(&path, artifact.to_string()).unwrap();
        let error = load_equilibrium_artifact_v7(path.to_str().unwrap(), 1)
            .expect_err("tampering after digest creation must fail closed");
        assert!(error.message.contains("content_sha256"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn equilibrium_artifact_v7_loader_rejects_arbitrary_declared_hash_and_id() {
        let path = std::env::temp_dir().join(format!(
            "fullmag-eigen-equilibrium-v7-forged-{}.json",
            std::process::id()
        ));
        let completion_sha256 = format!("sha256:{}", "0".repeat(64));
        let forged_sha256 = format!("sha256:{}", "f".repeat(64));
        let artifact = serde_json::json!({
            "schema_version": "equilibrium_artifact.v7",
            "accepted_for_linearization": true,
            "acceptance_certificate": {
                "criterion": "torque", "metric_kind": "max_torque_apm",
                "metric_value": 0.4, "threshold": 0.5, "unit": "A/m",
                "status": "completed", "converged": true, "stop_reason": "torque",
                "completion_sha256": completion_sha256,
            },
            "completion_sha256": completion_sha256,
            "producer_run_id": "run:eq", "content_sha256": forged_sha256,
            "equilibrium_id": format!("equilibrium_artifact.v7:{}", "f".repeat(64)),
            "mesh_signature": format!("sha256:{}", "1".repeat(64)),
            "material_signature": format!("sha256:{}", "2".repeat(64)), "physics_signature": format!("sha256:{}", "3".repeat(64)),
            "boundary_signature": format!("sha256:{}", "4".repeat(64)), "static_demag_signature": format!("sha256:{}", "5".repeat(64)),
            "m0": [[0.0, 0.0, 1.0]], "h_eff0_a_per_m": [[0.0, 0.0, 1.0]],
            "h_demag0_a_per_m": [[0.0, 0.0, 0.0]], "phi0_a": [0.0],
            "phi0_requirement": "required_for_restart_or_provenance",
            "observables": {"max_torque_Apm": 0.4, "max_torque_T": 5.026548245743669e-7, "max_torque_relative": 3.2e-5},
            "representation_integrity": {"m0_norm_tolerance": 1e-10},
            "periodic_mesh_certificate": {"schema_version": "periodic_mesh_certificate.v6", "certificate_id": "periodic_mesh_certificate.v6:cert", "content_sha256": "sha256:cert", "certificate": {"certificate_status": "accepted"}}
        });

        std::fs::write(&path, artifact.to_string()).unwrap();
        let error = load_equilibrium_artifact_v7(path.to_str().unwrap(), 1)
            .expect_err("a self-consistent but arbitrary declared hash/id must fail closed");
        assert!(error.message.contains("content_sha256"));
        std::fs::remove_file(path).unwrap();
    }
}
