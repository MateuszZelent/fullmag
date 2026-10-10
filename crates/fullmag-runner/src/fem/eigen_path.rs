//! FEM eigen path orchestration and dispersion artifacts.

use fullmag_ir::{FemEigenPlanIR, OutputIR, ParallelExecutionModeIR, ParallelExecutionPolicyIR};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use crate::dispatch::FemEngine;
use crate::eigen::diagnostic_artifact::{
    build_eigen_diagnostics_v2, canonical_mass_orthogonality_rows,
    EigenDiagnosticModeRecord, EigenDiagnosticSampleRecord,
};
use crate::eigen::output_selection::{select_eigen_outputs, EigenOutputSelection, SampleModeId};
use crate::eigen::{KSampleDescriptor, SingleKModeResult, SingleKSolveResult};
use crate::fem::eigen_capability::native_cpu_modal_window_enabled;
use crate::fem::eigen_execution_resolution::{FemEigenExecutionLane, PlannedFemEigenExecution};
use crate::fem::eigen_k_pool::{
    prepare_process_pool_samples, PrecomputedSingleK, ProcessPoolPreparation,
};
use crate::fem::eigen_reduction::{build_reduction_map, ReductionMap};
use crate::fem_eigen;
use crate::types::{AuxiliaryArtifact, ExecutedRun, RunError, RunStatus, StepStats};
use fullmag_engine::fem::MeshTopology;

/// Public outputs resolved for one path sample, kept separate from the
/// all-candidate outputs required by internal mode tracking.
#[derive(Debug, Clone)]
pub(super) struct EigenPathPotentialPublication {
    pub(super) outputs: Vec<OutputIR>,
    pub(super) sample_index: usize,
    pub(super) sample_label: Option<String>,
}

impl EigenPathPotentialPublication {
    pub(super) fn selected_mode_indices(
        &self,
        returned_count: usize,
    ) -> Result<BTreeSet<u32>, RunError> {
        let count = u32::try_from(returned_count).map_err(|_| RunError {
            message: "returned native mode count exceeds output selector range".to_string(),
        })?;
        let available = (0..count).collect();
        Ok(eigen_path_candidate_mode_indices_for_sample(
            &self.outputs,
            self.sample_index,
            self.sample_label.as_deref(),
            &available,
        ))
    }

    pub(super) fn pretracking_mode_indices(
        &self,
        returned_count: usize,
    ) -> Result<BTreeSet<u32>, RunError> {
        let early_outputs = self
            .outputs
            .iter()
            .filter(|output| {
                !matches!(
                    output,
                    OutputIR::EigenMode { branches, .. } if !branches.is_empty()
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        if early_outputs.len() == self.outputs.len() {
            return self.selected_mode_indices(returned_count);
        }
        let count = u32::try_from(returned_count).map_err(|_| RunError {
            message: "returned native mode count exceeds output selector range".to_string(),
        })?;
        let available = (0..count).collect();
        Ok(eigen_path_candidate_mode_indices_for_sample(
            &early_outputs,
            self.sample_index,
            self.sample_label.as_deref(),
            &available,
        ))
    }
}

pub(crate) fn eigen_diagnostics_transport_metadata(
    result: &crate::eigen::PathSolveResult,
    plan: Option<&FemEigenPlanIR>,
) -> Value {
    eigen_path_diagnostics_transport_metadata(result, plan)
}

#[path = "eigen_path_artifacts.rs"]
mod eigen_path_artifacts;
#[path = "eigen_path_guards.rs"]
mod eigen_path_guards;
#[path = "eigen_path_manifest.rs"]
mod eigen_path_manifest;
use eigen_path_artifacts::*;
pub(super) use eigen_path_artifacts::{
    eigen_path_candidate_mode_indices_for_sample, eigen_path_tracking_outputs,
};
pub(super) use eigen_path_guards::eigen_path_single_k_point_plan;
use eigen_path_guards::*;
use eigen_path_manifest::*;

pub(super) struct InterruptedSingleK {
    pub(super) status: RunStatus,
    pub(super) steps: Vec<StepStats>,
    pub(super) provenance: crate::ExecutionProvenance,
    pub(super) diagnostic_artifacts: Vec<AuxiliaryArtifact>,
}

pub(super) enum SingleKCheckpointAdmission {
    Completed,
    Interrupted(InterruptedSingleK),
}

pub(super) fn checkpoint_and_admit_single_k(
    checkpoint_root: Option<&Path>,
    sample: &KSampleDescriptor,
    point_plan: &FemEigenPlanIR,
    run: &ExecutedRun,
) -> Result<SingleKCheckpointAdmission, RunError> {
    let diagnostic_artifacts = match (checkpoint_root, run.result.status) {
        (Some(root), RunStatus::Cancelled | RunStatus::Paused) => {
            let _checkpoint_manifest =
                super::single_k_checkpoint::write_interrupted_single_k_checkpoint(
                    root,
                    sample.sample_index,
                    sample.k_vector,
                    point_plan,
                    &run.auxiliary_artifacts,
                    run.result.status,
                    &run.provenance,
                )
                .map_err(|error| RunError {
                    message: format!(
                        "failed to preserve raw FEM sample {}: {error}",
                        sample.sample_index
                    ),
                })?;
            Vec::new()
        }
        (Some(root), RunStatus::Completed | RunStatus::Failed) => {
            let _checkpoint_manifest = super::single_k_checkpoint::write_raw_single_k_checkpoint(
                root,
                sample.sample_index,
                sample.k_vector,
                point_plan,
                &run.auxiliary_artifacts,
            )
            .map_err(|error| RunError {
                message: format!(
                    "failed to preserve raw FEM sample {}: {error}",
                    sample.sample_index
                ),
            })?;
            Vec::new()
        }
        (None, RunStatus::Cancelled | RunStatus::Paused) => {
            super::single_k_checkpoint::interrupted_single_k_diagnostic_artifacts(
                sample.sample_index,
                sample.k_vector,
                point_plan,
                &run.auxiliary_artifacts,
                run.result.status,
                &run.provenance,
            )
            .map_err(|error| RunError {
                message: format!(
                    "failed to preserve raw FEM diagnostics for sample {}: {error}",
                    sample.sample_index
                ),
            })?
        }
        (None, RunStatus::Completed | RunStatus::Failed) => Vec::new(),
    };

    match run.result.status {
        RunStatus::Completed => Ok(SingleKCheckpointAdmission::Completed),
        RunStatus::Cancelled | RunStatus::Paused => Ok(SingleKCheckpointAdmission::Interrupted(
            InterruptedSingleK {
                status: run.result.status,
                steps: run.result.steps.clone(),
                provenance: run.provenance.clone(),
                diagnostic_artifacts,
            },
        )),
        RunStatus::Failed => Err(RunError {
            message: format!(
                "FEM eigen sample {} returned failed status",
                sample.sample_index
            ),
        }),
    }
}

fn interrupted_eigen_path_run(
    plan: &FemEigenPlanIR,
    interrupted: InterruptedSingleK,
    accepted_magnetization: Vec<[f64; 3]>,
) -> ExecutedRun {
    debug_assert!(matches!(
        interrupted.status,
        RunStatus::Cancelled | RunStatus::Paused
    ));
    let status = interrupted.status;
    ExecutedRun {
        result: crate::types::RunResult {
            status,
            steps: interrupted.steps,
            final_magnetization: accepted_magnetization,
            completion: Some(crate::relaxation::resolve_stage_completion(
                status,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts: interrupted.diagnostic_artifacts,
        provenance: interrupted.provenance,
    }
}

fn eigen_path_sample_id_prefix(plan: &FemEigenPlanIR) -> &'static str {
    if bias_field_sweep_requested(plan) {
        "bias-field-sample"
    } else if matches!(plan.k_sampling, Some(fullmag_ir::KSamplingIR::Path { .. })) {
        "k-path-sample"
    } else {
        "k-sample"
    }
}

pub(super) fn eigen_path_reduced_node_mass_weights(
    topology: &MeshTopology,
    reduction: &ReductionMap,
    physical_node_weights: &[f64],
) -> Result<Vec<f64>, RunError> {
    if physical_node_weights.len() == reduction.active_nodes.len() {
        return Ok(physical_node_weights.to_vec());
    }
    let physical_nodes = topology
        .magnetic_node_volumes
        .iter()
        .enumerate()
        .filter_map(|(node, volume)| (*volume > 0.0).then_some(node))
        .collect::<Vec<_>>();
    if physical_node_weights.len() != physical_nodes.len() {
        return Err(RunError {
            message: format!(
                "eigen path FE mass metadata has {} weights for {} physical and {} reduced tracking nodes",
                physical_node_weights.len(),
                physical_nodes.len(),
                reduction.active_nodes.len(),
            ),
        });
    }

    let mut reduced_weights = vec![0.0; reduction.active_nodes.len()];
    for (node, weight) in physical_nodes.into_iter().zip(physical_node_weights) {
        if !(weight.is_finite() && *weight > 0.0) {
            return Err(RunError {
                message: "eigen path FE mass metadata contains a non-positive or non-finite weight"
                    .to_string(),
            });
        }
        if let Some(reduced_index) = reduction.node_map[node] {
            reduced_weights[reduced_index] += *weight;
        }
    }
    if reduced_weights
        .iter()
        .any(|weight| !(weight.is_finite() && *weight > 0.0))
    {
        return Err(RunError {
            message:
                "eigen path FE mass reduction produced a non-positive or non-finite class weight"
                    .to_string(),
        });
    }
    Ok(reduced_weights)
}

pub(super) fn eigen_path_consistent_tracking_metric(
    topology: &MeshTopology,
    mesh: &fullmag_ir::MeshIR,
) -> Result<std::sync::Arc<crate::eigen::types::ConsistentP1TrackingMetric>, RunError> {
    let fail = |message: String| RunError {
        message: format!("eigen path consistent mass: {message}"),
    };
    let nodes = topology
        .magnetic_node_volumes
        .iter()
        .enumerate()
        .filter_map(|(node, volume)| (*volume > 0.0).then_some(node))
        .collect::<Vec<_>>();
    let mut mapping = vec![None; topology.n_nodes];
    for (local, node) in nodes.iter().copied().enumerate() {
        mapping[node] = Some(local);
    }
    let mut tetra = Vec::new();
    let mut volumes = Vec::new();
    for (index, cell) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[index] {
            continue;
        }
        let mut mapped = [0; 4];
        for (slot, node) in cell.iter().copied().enumerate() {
            mapped[slot] = mapping
                .get(node as usize)
                .copied()
                .flatten()
                .ok_or_else(|| {
                    fail("magnetic tetra node is not in the physical indexing".into())
                })?;
        }
        tetra.push(mapped);
        volumes.push(topology.element_volumes[index]);
    }
    let identity = mesh.mixed_topology_fingerprint_v3().map_err(fail)?;
    let metric =
        crate::eigen::types::ConsistentP1TrackingMetric::new(identity, nodes, tetra, &volumes)
            .map_err(fail)?;
    Ok(std::sync::Arc::new(metric))
}

fn eigen_path_sample_id(plan: &FemEigenPlanIR, sample: &KSampleDescriptor) -> String {
    format!(
        "{}-{:04}",
        eigen_path_sample_id_prefix(plan),
        sample.sample_index
    )
}

fn eigen_path_sample_id_for_index(plan: &FemEigenPlanIR, sample_index: usize) -> String {
    format!("{}-{sample_index:04}", eigen_path_sample_id_prefix(plan))
}

fn eigen_path_native_mode_identities(
    native_modes: &[Value],
    sample_index: usize,
) -> Result<Vec<(usize, f64)>, RunError> {
    let mut seen = BTreeSet::new();
    native_modes
        .iter()
        .enumerate()
        .map(|(position, mode)| {
            let raw_mode_index = mode["index"]
                .as_u64()
                .and_then(|index| usize::try_from(index).ok())
                .ok_or_else(|| RunError {
                    message: format!(
                        "single-k spectrum sample={sample_index} mode_position={position} has no valid raw mode index"
                    ),
                })?;
            if !seen.insert(raw_mode_index) {
                return Err(RunError {
                    message: format!(
                        "single-k spectrum sample={sample_index} repeats raw mode index {raw_mode_index}"
                    ),
                });
            }
            let frequency_hz = mode["frequency_real_hz"]
                .as_f64()
                .filter(|frequency| frequency.is_finite())
                .ok_or_else(|| RunError {
                    message: format!(
                        "single-k spectrum sample={sample_index} raw_mode={raw_mode_index} has no finite frequency_real_hz"
                    ),
                })?;
            Ok((raw_mode_index, frequency_hz))
        })
        .collect()
}

fn eigen_path_mode_id(sample_index: usize, raw_mode_index: usize) -> String {
    format!("sample-{sample_index:04}/mode-{raw_mode_index:04}")
}

fn eigen_path_overlap_values(
    path_result: &crate::eigen::PathSolveResult,
    selection: &EigenOutputSelection,
) -> Vec<f64> {
    path_result
        .branches
        .iter()
        .flat_map(|branch| &branch.points)
        .filter(|point| {
            selection.contains_spectrum_mode(point.sample_index, point.raw_mode_index)
                || selection.contains_field_mode(point.sample_index, point.raw_mode_index)
                || selection.contains_tracking_mode(point.sample_index, point.raw_mode_index)
        })
        .filter_map(|point| point.overlap_prev)
        .collect()
}

pub(super) fn relax_stage_handoff_for_path_sample<'a>(
    path_plan: &FemEigenPlanIR,
    source_relax_handoff: Option<&'a fem_eigen::AcceptedFemRelaxStageHandoff>,
) -> Option<&'a fem_eigen::AcceptedFemRelaxStageHandoff> {
    if bias_field_sweep_requested(path_plan) {
        None
    } else {
        source_relax_handoff
    }
}

pub(super) fn reuse_promoted_eigen_handoff(
    source_relax_handoff_available: bool,
    promoted_eigen_handoff_available: bool,
) -> bool {
    promoted_eigen_handoff_available && !source_relax_handoff_available
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    #[test]
    fn tracking_only_mode_contributes_to_overlap_summary_without_public_mode_selection() {
        let sample_index = 12;
        let raw_mode_index = 7;
        let branch_id = 3;
        let path_result = crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: 2.211e5,
            samples: vec![SingleKSolveResult {
                sample: KSampleDescriptor {
                    sample_index,
                    label: Some("X".to_string()),
                    segment_index: Some(0),
                    path_s: 1.0,
                    t_in_segment: 0.5,
                    k_vector: [1.0e7, 0.0, 0.0],
                },
                modes: vec![SingleKModeResult {
                    raw_mode_index,
                    branch_id: Some(branch_id),
                    frequency_real_hz: 2.0e9,
                    frequency_imag_hz: 0.0,
                    angular_frequency_rad_per_s: 2.0e9 * std::f64::consts::TAU,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: 2.0e9,
                    norm: 1.0,
                    mass_norm: Some(1.0),
                    max_amplitude: 1.0,
                    residual_relative_l2: None,
                    residual_norm: None,
                    residual_linf: None,
                    tangent_leakage_mean_abs: None,
                    tangent_leakage_max_abs: None,
                    tangent_leakage_weighted_relative_l2: None,
                    dominant_polarization: "x".to_string(),
                    reduced_vector: None,
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: None,
                    consistent_p1_metric: None,
                    component_participation:
                        crate::eigen::ModalParticipationObservable::unavailable_without_context(
                            "test",
                        ),
                }],
                relaxation_steps: 0,
                solver_model: crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent,
                solver_notes: Vec::new(),
                solver_diagnostics: None,
            }],
            branches: vec![crate::eigen::TrackedBranch {
                branch_id,
                label: Some("tracked-only".to_string()),
                points: vec![crate::eigen::TrackedBranchPoint {
                    sample_index,
                    raw_mode_index,
                    frequency_real_hz: 2.0e9,
                    frequency_imag_hz: 0.0,
                    tracking_confidence: 0.8,
                    overlap_prev: Some(0.625),
                    tracking_edge: None,
                }],
            }],
            solver_model: crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let selection = select_eigen_outputs(
            &path_result,
            &[OutputIR::EigenDiagnostics {
                include_tracking: true,
                include_residuals: false,
                include_overlaps: false,
                include_tangent_leakage: false,
                include_orthogonality: false,
            }],
        )
        .expect("tracking diagnostics selection is valid");

        assert!(selection.spectrum_mode_ids().is_empty());
        assert!(selection.field_mode_ids().is_empty());
        assert!(selection.contains_tracking_mode(sample_index, raw_mode_index));
        assert_eq!(
            super::eigen_path_overlap_values(&path_result, &selection),
            vec![0.625],
        );
    }

    #[test]
    fn native_mode_identity_rejects_missing_fields_and_duplicates() {
        for invalid in [
            serde_json::json!({"frequency_real_hz": 1.0e9}),
            serde_json::json!({"index": -1, "frequency_real_hz": 1.0e9}),
            serde_json::json!({"index": 1.5, "frequency_real_hz": 1.0e9}),
            serde_json::json!({"index": 2}),
            serde_json::json!({"index": 2, "frequency_real_hz": "1e9"}),
            serde_json::json!({"index": 2, "frequency_real_hz": null}),
        ] {
            assert!(super::eigen_path_native_mode_identities(&[invalid], 3).is_err());
        }
        let explicit_zero = serde_json::json!({"index": 7, "frequency_real_hz": 0.0});
        assert_eq!(
            super::eigen_path_native_mode_identities(&[explicit_zero.clone()], 3).unwrap(),
            vec![(7, 0.0)]
        );
        let duplicate = serde_json::json!({"index": 7, "frequency_real_hz": 1.0e9});
        assert!(super::eigen_path_native_mode_identities(&[explicit_zero, duplicate], 3).is_err());
        let unordered = [
            serde_json::json!({"index": 9, "frequency_real_hz": 2.0e9}),
            serde_json::json!({"index": 1, "frequency_real_hz": 1.0e9}),
        ];
        assert_eq!(
            super::eigen_path_native_mode_identities(&unordered, 3).unwrap(),
            vec![(9, 2.0e9), (1, 1.0e9)]
        );
    }

    pub(crate) fn bind_eigen_path_handoff_diagnostics(
        diagnostics: &mut serde_json::Value,
        sample_index: usize,
        handoff_sha256: &str,
        source_mesh_topology_sha256: &str,
    ) {
        super::bind_eigen_path_handoff_diagnostics(
            diagnostics,
            sample_index,
            handoff_sha256,
            source_mesh_topology_sha256,
            source_mesh_topology_sha256,
        );
    }

    pub(crate) fn eigen_path_component_participation_from_json(
        value: Option<&serde_json::Value>,
        solver_device: &str,
    ) -> Result<crate::eigen::ModalParticipationObservable, crate::types::RunError> {
        super::eigen_path_component_participation_from_json(value, solver_device)
    }

    pub(crate) fn remap_single_k_mode_artifacts(
        artifacts: &[crate::types::AuxiliaryArtifact],
        sample_index: usize,
        published_mode_indices: &BTreeSet<u32>,
    ) -> Result<Vec<crate::types::AuxiliaryArtifact>, RunError> {
        super::remap_single_k_mode_artifacts(artifacts, sample_index, published_mode_indices)
    }

    pub(crate) fn eigen_path_state_metadata_paths(
        mode_artifacts: &[crate::types::AuxiliaryArtifact],
        state_name: &str,
    ) -> Vec<String> {
        super::eigen_path_state_metadata_paths(mode_artifacts, state_name)
    }

    pub(crate) fn eigen_path_calculation_mode(
        result: &crate::eigen::PathSolveResult,
    ) -> &'static str {
        super::eigen_path_calculation_mode(result)
    }

    pub(crate) fn eigen_path_public_mode_indices(
        outputs: &[OutputIR],
        mode_count: u32,
    ) -> BTreeSet<u32> {
        super::eigen_path_public_mode_indices(outputs, mode_count)
    }

    pub(crate) fn eigen_path_mode_artifact_indices(outputs: &[OutputIR]) -> BTreeSet<u32> {
        super::eigen_path_mode_artifact_indices(outputs)
    }

    pub(crate) fn eigen_path_line_width_hz(frequency_imag_hz: f64) -> Option<String> {
        super::eigen_path_line_width_hz(frequency_imag_hz)
    }

    pub(crate) fn eigen_path_single_k_solver_model(
        plan: &FemEigenPlanIR,
        artifacts: &[crate::types::AuxiliaryArtifact],
    ) -> crate::eigen::EigenSolverModel {
        super::eigen_path_single_k_solver_model(plan, artifacts)
    }

    pub(crate) fn eigen_path_solver_diagnostics(
        engine: FemEngine,
        plan: &FemEigenPlanIR,
        result: &crate::eigen::PathSolveResult,
        published_mode_indices: &BTreeSet<u32>,
    ) -> serde_json::Value {
        let selected = result
            .samples
            .iter()
            .flat_map(|sample| {
                sample
                    .modes
                    .iter()
                    .filter(|mode| {
                        published_mode_indices
                            .contains(&u32::try_from(mode.raw_mode_index).unwrap_or(u32::MAX))
                    })
                    .map(|mode| SampleModeId::new(sample.sample.sample_index, mode.raw_mode_index))
            })
            .collect();
        super::eigen_path_solver_diagnostics(engine, plan, result, &selected)
    }

    pub(crate) fn eigen_path_mode_json(
        plan: &FemEigenPlanIR,
        sample: &crate::eigen::KSampleDescriptor,
        mode: &crate::eigen::SingleKModeResult,
        solver_model: crate::eigen::EigenSolverModel,
        solver_diagnostics: Option<&serde_json::Value>,
    ) -> serde_json::Value {
        super::eigen_path_mode_json(plan, sample, mode, solver_model, solver_diagnostics)
    }

    pub(crate) fn eigen_path_single_k_point_plan(
        plan: &FemEigenPlanIR,
        sample: &crate::eigen::KSampleDescriptor,
        reuse_relaxed_equilibrium: bool,
        handoff: Option<&fem_eigen::AcceptedFemEigenEquilibriumHandoff>,
    ) -> Result<FemEigenPlanIR, RunError> {
        super::eigen_path_single_k_point_plan(plan, sample, reuse_relaxed_equilibrium, handoff)
    }

    pub(crate) fn eigen_path_equilibrium_source_json(
        plan: &FemEigenPlanIR,
        relaxation_steps: u64,
    ) -> serde_json::Value {
        super::eigen_path_equilibrium_source_json(plan, relaxation_steps)
    }

    pub(crate) fn eigen_path_external_field(
        plan: &FemEigenPlanIR,
        sample_index: usize,
    ) -> Option<[f64; 3]> {
        super::eigen_path_external_field(plan, sample_index)
    }

    pub(crate) fn eigen_path_node_mass_weights_from_json(
        value: &serde_json::Value,
    ) -> Option<Vec<f64>> {
        super::eigen_path_node_mass_weights_from_json(value)
    }

    pub(crate) fn build_eigen_path_frequency_domain_manifest(
        engine: FemEngine,
        result: &crate::eigen::PathSolveResult,
        mode_artifacts: &[crate::types::AuxiliaryArtifact],
        plan: &FemEigenPlanIR,
    ) -> serde_json::Value {
        let outputs = vec![
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".into(),
            },
            OutputIR::DispersionCurve {
                name: "dispersion".into(),
                include_branch_table: true,
            },
        ];
        super::build_eigen_path_frequency_domain_manifest(
            engine,
            result,
            mode_artifacts,
            plan,
            &outputs,
        )
    }

    pub(crate) fn append_eigen_path_k0_kittel_validation_artifacts(
        auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
        result: &crate::eigen::PathSolveResult,
    ) -> Result<(), RunError> {
        super::append_eigen_path_k0_kittel_validation_artifacts(auxiliary_artifacts, result)
    }

    pub(crate) fn eigen_path_gpu_modal_device_contract(diagnostics: &serde_json::Value) -> bool {
        super::eigen_path_gpu_modal_device_contract(diagnostics)
    }

    pub(crate) fn gpu_modal_k0_kittel_path_supported(plan: &FemEigenPlanIR) -> bool {
        super::gpu_modal_k0_kittel_path_supported(plan)
    }

    pub(crate) fn periodic_airbox_k0_physical_plan(plan: &FemEigenPlanIR) -> bool {
        super::periodic_airbox_k0_physical_plan(plan)
    }

    pub(crate) fn periodic_airbox_k0_runtime_supported(plan: &FemEigenPlanIR) -> bool {
        super::periodic_airbox_k0_runtime_supported(plan)
    }

    pub(crate) fn eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(
        plan: &FemEigenPlanIR,
        artifacts: &[AuxiliaryArtifact],
    ) -> Result<Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>, RunError> {
        super::eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(plan, artifacts)
    }

    pub(crate) fn k0_kittel_synthetic_demag_factor_enabled(plan: &FemEigenPlanIR) -> bool {
        super::k0_kittel_synthetic_demag_factor_enabled(plan)
    }

    pub(crate) fn solve_k0_kittel_synthetic_demag_factor_single_k(
        plan: &FemEigenPlanIR,
        sample: &crate::eigen::KSampleDescriptor,
    ) -> Result<crate::eigen::SingleKSolveResult, RunError> {
        super::solve_k0_kittel_synthetic_demag_factor_single_k(plan, sample)
    }

    /// Exercise the production native artifact publisher with deterministic
    /// modal data. This is an artifact-pipeline fixture, not a solver or
    /// physical-validation proof.
    fn bias_field_fixture_periodic_mesh() -> fullmag_ir::MeshIR {
        fullmag_ir::MeshIR {
            mesh_name: "bias_field_artifact_pipeline_mesh".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [1.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 1.0],
                [0.0, 1.0, 1.0],
                [1.0, 1.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                [0, 1, 3, 7],
                [0, 3, 2, 7],
                [0, 2, 6, 7],
                [0, 6, 4, 7],
                [0, 4, 5, 7],
                [0, 5, 1, 7],
            ]),
            element_markers: vec![1; 6],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                [0, 6, 2],
                [0, 4, 6],
                [1, 3, 7],
                [1, 7, 5],
                [0, 1, 5],
                [0, 5, 4],
                [2, 7, 3],
                [2, 6, 7],
                [0, 3, 1],
                [0, 2, 3],
                [4, 5, 7],
                [4, 7, 6],
            ]),
            boundary_markers: vec![1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3],
            periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "test-periodic-x".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 1,
                marker_b: 2,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: [(0, 1), (2, 3), (4, 5), (6, 7)]
                .into_iter()
                .map(|(node_a, node_b)| fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "test-periodic-x".to_string(),
                    node_a,
                    node_b,
                })
                .collect(),
            per_domain_quality: std::collections::HashMap::new(),
        }
    }

    fn bias_field_fixture_relax_source_plan(
        plan: &FemEigenPlanIR,
    ) -> fullmag_ir::FemPlanIR {
        let mut source_plan = fullmag_ir::FemPlanIR::default();
        source_plan.mesh_name = plan.mesh_name.clone();
        source_plan.mesh_source = plan.mesh_source.clone();
        source_plan.mesh = plan.mesh.clone();
        source_plan.object_segments = plan.object_segments.clone();
        source_plan.mesh_parts = plan.mesh_parts.clone();
        source_plan.mesh_build_report = plan.mesh_build_report.clone();
        source_plan.domain_mesh_mode = plan.domain_mesh_mode;
        source_plan.domain_frame = plan.domain_frame.clone();
        source_plan.fe_order = plan.fe_order;
        source_plan.hmax = plan.hmax;
        source_plan.initial_magnetization = plan.equilibrium_magnetization.clone();
        source_plan.material = plan.material.clone();
        source_plan.enable_exchange = plan.enable_exchange;
        source_plan.enable_demag = plan.enable_demag;
        source_plan.external_field = plan.external_field;
        source_plan.gyromagnetic_ratio = plan.gyromagnetic_ratio;
        source_plan.precision = plan.precision;
        source_plan.exchange_bc = plan.exchange_bc;
        source_plan.integrator = Some(fullmag_ir::IntegratorChoice::Heun);
        source_plan.fixed_timestep = Some(1.0e-13);
        source_plan.relaxation = Some(fullmag_ir::RelaxationControlIR {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1.0e-4),
                energy_tolerance_j: None,
                max_steps: Some(8),
                max_relaxation_time_s: None,
            },
        });
        source_plan.demag_realization = plan.demag_realization;
        source_plan.air_box_config = plan.air_box_config.clone();
        source_plan.interfacial_dmi = plan.interfacial_dmi;
        source_plan.dmi_interface_normal = plan.dmi_interface_normal;
        source_plan.bulk_dmi = plan.bulk_dmi;
        source_plan
    }

    fn bias_field_fixture_linearization_state(
        point_plan: &FemEigenPlanIR,
    ) -> Result<crate::fem::eigen_types::SharedDomainLinearizationState, RunError> {
        let topology = MeshTopology::from_ir(&point_plan.mesh).map_err(|error| RunError {
            message: error.to_string(),
        })?;
        let mut materialization_plan = point_plan.clone();
        materialization_plan.equilibrium = fullmag_ir::EquilibriumSourceIR::Provided;
        let (problem, equilibrium, _, observables, _) =
            crate::fem::eigen_equilibrium::materialize_equilibrium(
                &materialization_plan,
                &point_plan.equilibrium_magnetization,
                None,
            )?;
        let phi0 = problem
            .demag_potential_from_vectors(&equilibrium)
            .map_err(|error| RunError {
                message: format!("fixture equilibrium potential failed: {error}"),
            })?;
        let certified_fields = crate::types::CertifiedFemEquilibriumFields::from_fields(
            observables.exchange_field.clone(),
            observables.demag_field.clone(),
            observables.external_field.clone(),
            observables.effective_field.clone(),
            phi0,
        )
        .map_err(|error| RunError {
            message: error.to_string(),
        })?;
        let source_plan = bias_field_fixture_relax_source_plan(point_plan);
        let source_mesh = crate::types::FemMeshPayload::from(&source_plan);
        let completion = fullmag_ir::StageCompletionIR {
            status: "completed".to_string(),
            converged: true,
            reason: Some(fullmag_ir::StageStopReason::Torque),
            metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
            metric_name: Some("max_torque_apm".to_string()),
            metric_value: Some(5.0e-5),
            threshold: Some(1.0e-4),
        };
        let handoff = crate::fem_eigen::AcceptedFemRelaxStageHandoff::from_completed_relax(
            "run-bias-field-fixture",
            "stage-000",
            "flat_relax",
            true,
            &source_plan,
            &source_mesh,
            &completion,
            equilibrium.clone(),
            certified_fields,
        )?;
        let (problem, equilibrium, _, observables, _) =
            crate::fem::eigen_equilibrium::materialize_equilibrium(
                point_plan,
                &equilibrium,
                Some(&handoff),
            )?;
        crate::fem::eigen_shared_domain::build_shared_domain_linearization_state(
            point_plan,
            &topology,
            &problem,
            None,
            Some(&handoff),
            &equilibrium,
            &observables,
        )
    }

    fn bias_field_native_artifact_pipeline_fixture(
        point_plan: &FemEigenPlanIR,
        sample_index: usize,
        tracking_outputs: &[OutputIR],
    ) -> Result<crate::types::ExecutedRun, RunError> {
        let topology = MeshTopology::from_ir(&point_plan.mesh).map_err(|error| RunError {
            message: error.to_string(),
        })?;
        let (scalar_classes, scalar_class_count, magnetic_classes, magnetic_class_count) =
            crate::fem::eigen_shared_domain_geometry::modal_shared_domain_equivalence_classes(
                &topology,
            )?;
        let scalar_class_count = usize::try_from(scalar_class_count).map_err(|_| RunError {
            message: "test scalar class count exceeds host dimensions".to_string(),
        })?;
        let reduction = build_reduction_map(
            &topology,
            &point_plan.spin_wave_bc,
            point_plan.k_sampling.as_ref(),
        )?;
        let active_count = reduction.active_nodes.len();
        let bases = crate::fem::eigen_projection::tangent_bases(
            &point_plan.equilibrium_magnetization,
        );
        let linearization_state = bias_field_fixture_linearization_state(point_plan)?;
        let k_vector = match point_plan.k_sampling.as_ref() {
            Some(fullmag_ir::KSamplingIR::Single { k_vector }) => serde_json::json!(k_vector),
            _ => serde_json::Value::Null,
        };
        let phase_constraint = serde_json::json!({
            "phase_convention": format!("{:?}", point_plan.spin_wave_bc.phase_convention()),
            "k_vector": k_vector,
            "periodic_node_pairs": point_plan.mesh.periodic_node_pairs,
            "periodic_boundary_pairs": point_plan.mesh.periodic_boundary_pairs,
            "magnetic_reduced_node": magnetic_classes,
            "scalar_reduced_node": scalar_classes,
            "tangent_bases": bases,
        });
        let phase_constraint_sha256 = crate::fem::eigen_digest::shared_domain_content_digest(
            "phase_constraint",
            &phase_constraint,
        )?;
        // Fixture provenance digests bind the actual sample plan and accepted
        // state inputs. This pipeline fixture does not claim a native operator
        // was assembled or solved.
        let operator_input_signature = serde_json::json!({
            "schema_version": "frequency_domain_operator_input_signature.v1",
            "assembly_kind": "bias_field_native_artifact_pipeline_fixture",
            "sample_index": sample_index,
            "external_field_a_per_m": point_plan.external_field,
            "k_vector": k_vector,
            "mesh_snapshot_id": linearization_state.mesh_snapshot_id,
            "material_snapshot_id": linearization_state.material_snapshot_id,
            "physics_snapshot_id": linearization_state.physics_snapshot_id,
            "boundary_snapshot_id": linearization_state.boundary_snapshot_id,
            "periodic_mesh_certificate_sha256":
                linearization_state.periodic_mesh_certificate_digest,
            "periodic_modal_equivalence_map_binding_sha256":
                linearization_state.periodic_mesh_certificate_map_binding_digest,
            "magnetic_reduced_node_count": magnetic_class_count,
            "scalar_reduced_node_count": scalar_class_count,
            "gyromagnetic_ratio_m_per_a_s": point_plan.gyromagnetic_ratio,
        });
        let operator_input_signature_sha256 =
            crate::fem::eigen_digest::shared_domain_content_digest(
                "operator_input_signature",
                &operator_input_signature,
            )?;
        let modes = (0..2_usize)
            .map(|raw_mode_index| {
                let follows_low_frequency_branch =
                    (sample_index == 0 && raw_mode_index == 0)
                        || (sample_index == 1 && raw_mode_index == 1);
                let scale = if sample_index == 0 { 1.0 } else { 1.25 };
                let component_offset = if follows_low_frequency_branch {
                    0
                } else {
                    active_count
                };
                let mut vector = vec![num_complex::Complex64::new(0.0, 0.0); 2 * active_count];
                for active_index in 0..active_count {
                    vector[component_offset + active_index] = num_complex::Complex64::new(scale, 0.0);
                }
                let phi_vector = (0..scalar_class_count)
                    .map(|class| {
                        num_complex::Complex64::new(
                            1.0 + sample_index as f64 * 2.0
                                + raw_mode_index as f64
                                + class as f64 * 0.125,
                            0.0,
                        )
                    })
                    .collect();
                let frequency_hz = match (sample_index, raw_mode_index) {
                    (0, 0) => 1.0e9,
                    (0, 1) => 2.0e9,
                    (1, 0) => 3.0e9,
                    (1, 1) => 1.1e9,
                    _ => unreachable!("fixture contains exactly two samples and two modes"),
                };
                let omega_rad_s = frequency_hz * std::f64::consts::TAU;
                crate::fem::eigen_native_result::NativeModalEigenpair {
                    cluster_id: raw_mode_index as u64,
                    frequency_hz,
                    omega_rad_s,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: omega_rad_s,
                    residual_absolute_l2: Some(0.0),
                    residual_relative_l2: 0.0,
                    residual_linf: Some(0.0),
                    mass_norm: 1.0,
                    block_residual_q: 0.0,
                    block_residual_phi: 0.0,
                    block_residual_gauge: None,
                    backend_reported_residual: Some(0.0),
                    vector,
                    q_vector: Vec::new(),
                    phi_vector,
                    floquet_descriptor_certified: false,
                    floquet_full_descriptor_certified: false,
                    floquet_seam_frame_certified: false,
                    floquet_gauge_policy_satisfied: false,
                    floquet_geometric_bc_certified: false,
                    floquet_poisson_boundary_kind: None,
                    floquet_poisson_gauge_policy: None,
                    floquet_potential_representation: None,
                    floquet_magnetic_relative_residual: None,
                    floquet_potential_relative_residual: None,
                    floquet_full_magnetic_relative_residual: None,
                    floquet_full_potential_relative_residual: None,
                    floquet_scalar_phase_seam_relative_residual: None,
                    floquet_tangent_frame_seam_relative_residual: None,
                    floquet_cartesian_magnetic_seam_relative_residual: None,
                    floquet_equilibrium_pair_relative_residual: None,
                    floquet_potential_real_split: Vec::new(),
                }
            })
            .collect::<Vec<_>>();
        let node_mass_weights = vec![1.0; active_count];
        let auxiliary_artifacts =
            crate::fem::eigen_native_artifacts::native_modal_artifacts(
                point_plan,
                tracking_outputs,
                &point_plan.equilibrium_magnetization,
                &reduction,
                &bases,
                &modes,
                Some(&node_mass_weights),
                serde_json::json!({
                    "assembly_kind": "mfem_weak_form_shared_domain",
                    "solver_backend": "bias_field_native_artifact_pipeline_fixture",
                    "solver_model": "bias_field_native_artifact_pipeline_fixture",
                    "solver_kind": "bias_field_native_artifact_pipeline_fixture",
                    "solver_adapter": "bias_field_native_artifact_pipeline_fixture",
                    "execution_lane": "cpu",
                    "solve_succeeded": true,
                    "fields_available": true,
                    "spectrum_completeness": "complete",
                    "window_complete": true,
                    "operator_input_signature_sha256": operator_input_signature_sha256,
                    "phase_constraint_sha256": phase_constraint_sha256,
                }),
                0,
                Some(&linearization_state),
                None,
                None,
                None,
                sample_index,
                Some(sample_index),
            )?;

        Ok(crate::types::ExecutedRun {
            result: crate::types::RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: point_plan.equilibrium_magnetization.clone(),
                completion: Some(crate::relaxation::resolve_stage_completion(
                    RunStatus::Completed,
                    None,
                    crate::relaxation::RelaxationCompletionMetrics::default(),
                )),
            },
            initial_magnetization: point_plan.equilibrium_magnetization.clone(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts,
            provenance: crate::ExecutionProvenance {
                execution_engine: "bias_field_native_artifact_pipeline_fixture".to_string(),
                precision: "double".to_string(),
                ..Default::default()
            },
        })
    }

    fn artifact_bytes<'a>(
        run: &'a crate::types::ExecutedRun,
        path: &str,
    ) -> Option<&'a [u8]> {
        run.auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == path)
            .map(|artifact| artifact.bytes.as_slice())
    }

    fn expected_cartesian_mode_bytes(
        node_count: usize,
        component: usize,
        scale: f64,
    ) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(node_count * 6 * std::mem::size_of::<f64>());
        for _ in 0..node_count {
            for axis in 0..3 {
                bytes.extend_from_slice(&(if axis == component { scale } else { 0.0 }).to_le_bytes());
                bytes.extend_from_slice(&0.0_f64.to_le_bytes());
            }
        }
        bytes
    }

    fn expected_bias_field_potential_bytes(
        plan: &FemEigenPlanIR,
        sample_index: usize,
        raw_mode_index: usize,
        scalar_class_count: usize,
        mode_metadata: &Value,
    ) -> Vec<crate::types::AuxiliaryArtifact> {
        let topology = MeshTopology::from_ir(&plan.mesh).expect("test mesh is valid");
        let (classes, _, _, _) =
            crate::fem::eigen_shared_domain_geometry::modal_shared_domain_equivalence_classes(
                &topology,
            )
            .expect("test periodic classes are valid");
        let mut point_plan = plan.clone();
        point_plan.external_field = Some(plan.bias_field_samples[sample_index].field_a_per_m);
        point_plan.bias_field_samples.clear();
        let phases = crate::fem::eigen_mass_metric::canonical_shared_domain_phases(
            &topology,
            &point_plan,
        )
        .expect("test Gamma phase map is valid");
        let phi_real = (0..scalar_class_count)
            .map(|class| {
                1.0 + sample_index as f64 * 2.0
                    + raw_mode_index as f64
                    + class as f64 * 0.125
            })
            .map(|value| num_complex::Complex64::new(value, 0.0))
            .collect::<Vec<_>>();
        let provenance = serde_json::json!({
            "source_mesh_topology_sha256": mode_metadata["source_mesh_topology_sha256"],
            "operator_input_signature_sha256": mode_metadata["operator_input_signature_sha256"],
            "phase_constraint_sha256": mode_metadata["phase_constraint_sha256"],
        });
        crate::fem::eigen_physical_potential::physical_potential_artifacts(
            &topology,
            &phi_real,
            scalar_class_count,
            &classes,
            &phases,
            sample_index,
            raw_mode_index,
            &provenance,
        )
        .expect("test physical potential artifacts are valid")
    }

    #[test]
    fn bias_field_branch_selection_tracks_native_publisher_artifacts_before_publication() {
        let mut plan = crate::fem::eigen_tests::minimal_native_modal_plan();
        // This direct adapter fixture preserves a near-Gamma internal vector;
        // public ProblemIR bias-field admission continues to require exact zero.
        plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [5.0e-13, 0.0, 0.0],
        });
        plan.mesh = bias_field_fixture_periodic_mesh();
        plan.mesh_name = plan.mesh.mesh_name.clone();
        plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        );
        plan.count = 2;
        plan.bias_field_samples = vec![
            fullmag_ir::FemEigenBiasFieldSamplePlanIR {
                sample_index: 0,
                field_a_per_m: [100.0, 0.0, 0.0],
                equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
                continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
                execution: test_bias_field_execution_resolution(),
            },
            fullmag_ir::FemEigenBiasFieldSamplePlanIR {
                sample_index: 1,
                field_a_per_m: [200.0, 0.0, 0.0],
                equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
                continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
                execution: test_bias_field_execution_resolution(),
            },
        ];
        let outputs = vec![OutputIR::EigenMode {
            field: "mode".to_string(),
            all_modes: false,
            indices: Vec::new(),
            branches: vec![0],
            sample_selector: None,
        }];
        assert!(crate::fem::eigen_sweep::bias_field_branch_tracking_requested(
            &outputs
        ));
        assert!(crate::fem::eigen_sweep::bias_field_branch_tracking_requested(&[
            OutputIR::DispersionCurve {
                name: "field sweep".to_string(),
                include_branch_table: true,
            }
        ]));
        assert!(crate::fem::eigen_sweep::bias_field_branch_tracking_requested(&[
            OutputIR::EigenDiagnostics {
                include_tracking: true,
                include_residuals: false,
                include_overlaps: false,
                include_tangent_leakage: false,
                include_orthogonality: false,
            }
        ]));
        let tracking_outputs = eigen_path_tracking_outputs(&outputs, plan.count);
        let merged = crate::fem::eigen_sweep::execute_bias_field_sweep_with_publication(
            &plan,
            &outputs,
            FemEngine::CpuNative,
            true,
            |point_plan, sample_index| {
                bias_field_native_artifact_pipeline_fixture(point_plan, sample_index, &tracking_outputs)
            },
        )
        .expect("native publisher samples should track and publish branch zero");

        let spectrum: Value = serde_json::from_slice(
            artifact_bytes(&merged, "eigen/spectrum.v2.json")
                .expect("final spectrum artifact is published"),
        )
        .expect("final spectrum JSON is valid");
        let samples = spectrum["samples"].as_array().expect("samples are published");
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0]["external_field_a_per_m"], serde_json::json!([100.0, 0.0, 0.0]));
        assert_eq!(samples[0]["k_vector"], serde_json::json!([5.0e-13, 0.0, 0.0]));
        assert_eq!(samples[1]["k_vector"], serde_json::json!([5.0e-13, 0.0, 0.0]));
        assert_eq!(samples[1]["external_field_a_per_m"], serde_json::json!([200.0, 0.0, 0.0]));
        assert_eq!(samples[0]["modes"].as_array().unwrap().len(), 1);
        assert_eq!(samples[1]["modes"].as_array().unwrap().len(), 1);
        assert_eq!(samples[0]["modes"][0]["branch_id"], 0);
        assert_eq!(samples[0]["modes"][0]["raw_mode_index"], 0);
        assert_eq!(samples[1]["modes"][0]["branch_id"], 0);
        assert_eq!(samples[1]["modes"][0]["raw_mode_index"], 1);
        assert_eq!(samples[0]["modes"][0]["mode_field_available"], true);
        assert_eq!(samples[1]["modes"][0]["mode_field_available"], true);
        assert_eq!(samples[0]["modes"][0]["k_vector"], serde_json::json!([5.0e-13, 0.0, 0.0]));
        assert_eq!(samples[1]["modes"][0]["k_vector"], serde_json::json!([5.0e-13, 0.0, 0.0]));
        let field_sweep: Value = serde_json::from_slice(
            artifact_bytes(&merged, "eigen/field_sweep.v1.json")
                .expect("native field-sweep provenance is published"),
        )
        .expect("native field-sweep JSON is valid");
        let field_sweep_samples = field_sweep["samples"]
            .as_array()
            .expect("native field-sweep samples are published");
        assert_eq!(field_sweep_samples.len(), 2);
        let (_, scalar_class_count, _, _) = crate::fem::eigen_shared_domain_geometry::
            modal_shared_domain_equivalence_classes(
                &MeshTopology::from_ir(&plan.mesh).expect("test mesh is valid"),
            )
            .expect("test periodic classes are valid");
        let scalar_class_count = usize::try_from(scalar_class_count).unwrap();

        let branches: Value = serde_json::from_slice(
            artifact_bytes(&merged, "eigen/branches.v2.json")
                .expect("final branch artifact is published"),
        )
        .expect("final branch JSON is valid");
        assert_eq!(branches["branches"].as_array().unwrap().len(), 1);
        assert_eq!(branches["branches"][0]["branch_id"], 0);
        assert_eq!(branches["branches"][0]["points"].as_array().unwrap().len(), 2);
        assert_eq!(branches["branches"][0]["points"][0]["k_vector"], serde_json::json!([5.0e-13, 0.0, 0.0]));
        assert_eq!(branches["branches"][0]["points"][1]["k_vector"], serde_json::json!([5.0e-13, 0.0, 0.0]));
        let dispersion = std::str::from_utf8(
            artifact_bytes(&merged, "eigen/dispersion.csv")
                .expect("final dispersion table is published"),
        )
        .expect("final dispersion table is UTF-8");
        assert!(dispersion.lines().any(|row| {
            let columns = row.split(',').collect::<Vec<_>>();
            columns.get(0) == Some(&"0")
                && columns.get(7) == Some(&"0")
                && columns.get(8) == Some(&"sample-0000/mode-0000")
                && columns.get(9) == Some(&"0")
        }));
        assert!(dispersion.lines().any(|row| {
            let columns = row.split(',').collect::<Vec<_>>();
            columns.get(0) == Some(&"1")
                && columns.get(7) == Some(&"1")
                && columns.get(8) == Some(&"sample-0001/mode-0001")
                && columns.get(9) == Some(&"0")
        }));

        for (sample_index, raw_mode_index, component, scale) in
            [(0, 0, 1, 1.0), (1, 1, 1, 1.25)]
        {
            let vector_path = format!(
                "eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}/vector.bin"
            );
            assert_eq!(
                artifact_bytes(&merged, &vector_path),
                Some(expected_cartesian_mode_bytes(plan.mesh.nodes.len(), component, scale).as_slice())
            );
            let zarr_attrs_path = format!(
                "eigen/mode_fields.zarr/sample_{sample_index:04}/mode_{raw_mode_index:04}/.zattrs"
            );
            let zarr_attrs: Value = serde_json::from_slice(
                artifact_bytes(&merged, &zarr_attrs_path)
                    .expect("selected Zarr mode metadata is published"),
            )
            .expect("selected Zarr mode metadata is valid JSON");
            assert_eq!(zarr_attrs["sample_index"], sample_index);
            assert_eq!(zarr_attrs["raw_mode_index"], raw_mode_index);
            assert_eq!(zarr_attrs["branch_id"], 0);
            let mode_metadata = &samples[sample_index]["modes"][0];
            for key in [
                "operator_input_signature_sha256",
                "phase_constraint_sha256",
                "equilibrium_artifact_sha256",
                "linearization_state_sha256",
                "periodic_mesh_certificate_sha256",
            ] {
                let digest = mode_metadata[key]
                    .as_str()
                    .unwrap_or_else(|| panic!("selected mode is missing {key}"));
                assert!(
                    crate::fem::eigen_digest::is_sha256_digest(digest),
                    "selected mode {key} must be a SHA-256 identity"
                );
            }
            let sample_metadata_prefix = format!("eigen/metadata/sample_{sample_index:04}");
            let equilibrium_artifact: Value = serde_json::from_slice(
                artifact_bytes(
                    &merged,
                    &format!("{sample_metadata_prefix}/equilibrium_artifact.v7.json"),
                )
                .expect("sample equilibrium artifact is preserved"),
            )
            .expect("sample equilibrium artifact JSON is valid");
            let linearization_state: Value = serde_json::from_slice(
                artifact_bytes(
                    &merged,
                    &format!("{sample_metadata_prefix}/linearization_state.v6.json"),
                )
                .expect("sample linearization state is preserved"),
            )
            .expect("sample linearization state JSON is valid");
            assert_eq!(
                mode_metadata["equilibrium_artifact_sha256"],
                equilibrium_artifact["content_sha256"]
            );
            assert_eq!(
                mode_metadata["linearization_state_sha256"],
                linearization_state["content_sha256"]
            );
            let certificate_digest =
                crate::fem::eigen_digest::shared_domain_content_digest(
                    "periodic_mesh_certificate_v6",
                    &equilibrium_artifact["periodic_mesh_certificate"],
                )
                .expect("published periodic certificate identity is digestible");
            assert_eq!(
                mode_metadata["periodic_mesh_certificate_sha256"],
                serde_json::json!(certificate_digest)
            );
            assert_eq!(
                linearization_state["periodic_mesh_certificate"],
                mode_metadata["periodic_mesh_certificate_sha256"]
            );
            assert_eq!(
                field_sweep_samples[sample_index]["equilibrium_artifact_sha256"],
                mode_metadata["equilibrium_artifact_sha256"]
            );
            assert_eq!(
                field_sweep_samples[sample_index]["linearization_state_sha256"],
                mode_metadata["linearization_state_sha256"]
            );
            assert_eq!(
                field_sweep_samples[sample_index]["operator_input_signature_sha256"],
                mode_metadata["operator_input_signature_sha256"]
            );
            let expected = expected_bias_field_potential_bytes(
                &plan,
                sample_index,
                raw_mode_index,
                scalar_class_count,
                mode_metadata,
            );
            for expected_artifact in expected {
                assert_eq!(
                    artifact_bytes(&merged, &expected_artifact.relative_path),
                    Some(expected_artifact.bytes.as_slice()),
                    "selected branch potential artifact {} must retain the exact publisher-bound values",
                    expected_artifact.relative_path
                );
            }
            let potential_manifest_path = format!(
                "eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}/physical_potential.v1.json"
            );
            let potential_manifest: Value = serde_json::from_slice(
                artifact_bytes(&merged, &potential_manifest_path)
                    .expect("selected physical-potential manifest is published"),
            )
            .expect("selected physical-potential manifest is valid JSON");
            for key in [
                "source_mesh_topology_sha256",
                "operator_input_signature_sha256",
                "phase_constraint_sha256",
            ] {
                assert_eq!(potential_manifest[key], mode_metadata[key]);
            }
        }
        for (sample_index, raw_mode_index) in [(0, 1), (1, 0)] {
            let prefix = format!(
                "eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}"
            );
            assert!(artifact_bytes(&merged, &format!("{prefix}/vector.bin")).is_none());
            assert!(artifact_bytes(&merged, &format!("{prefix}/potential_full.bin")).is_none());
            assert!(artifact_bytes(&merged, &format!("{prefix}/demag_element_full.bin")).is_none());
            let zarr_prefix = format!(
                "eigen/mode_fields.zarr/sample_{sample_index:04}/mode_{raw_mode_index:04}/"
            );
            assert!(!merged.auxiliary_artifacts.iter().any(|artifact| {
                artifact.relative_path.starts_with(&zarr_prefix)
            }));
        }

        let raw_outputs = vec![OutputIR::EigenMode {
            field: "mode".to_string(),
            all_modes: false,
            indices: vec![1],
            branches: Vec::new(),
            sample_selector: None,
        }];
        assert!(!crate::fem::eigen_sweep::bias_field_branch_tracking_requested(
            &raw_outputs
        ));
        let raw_mode_run = crate::fem::eigen_sweep::execute_bias_field_sweep_with_publication(
            &plan,
            &raw_outputs,
            FemEngine::CpuNative,
            false,
            |point_plan, sample_index| {
                bias_field_native_artifact_pipeline_fixture(point_plan, sample_index, &raw_outputs)
            },
        )
        .expect("raw mode-index selection should keep the sample-local publication path");
        let raw_spectrum: Value = serde_json::from_slice(
            artifact_bytes(&raw_mode_run, "eigen/spectrum.v2.json")
                .expect("raw-index spectrum is published"),
        )
        .expect("raw-index spectrum JSON is valid");
        for sample in raw_spectrum["samples"].as_array().unwrap() {
            let raw_zero = sample["modes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|mode| mode["raw_mode_index"] == 0)
                .expect("raw mode zero remains in the sample spectrum");
            let raw_one = sample["modes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|mode| mode["raw_mode_index"] == 1)
                .expect("raw mode one remains in the sample spectrum");
            assert_eq!(raw_zero["branch_id"], 0);
            assert_eq!(raw_one["branch_id"], 1);
            assert_eq!(raw_zero["mode_field_available"], false);
            assert_eq!(raw_one["mode_field_available"], true);
        }

        let tracking_diagnostic_outputs = vec![OutputIR::EigenDiagnostics {
            include_tracking: true,
            include_residuals: false,
            include_overlaps: false,
            include_tangent_leakage: false,
            include_orthogonality: false,
        }];
        let diagnostics_run = crate::fem::eigen_sweep::execute_bias_field_sweep_with_publication(
            &plan,
            &tracking_diagnostic_outputs,
            FemEngine::CpuNative,
            true,
            |point_plan, sample_index| {
                let internal_outputs =
                    eigen_path_tracking_outputs(&tracking_diagnostic_outputs, plan.count);
                bias_field_native_artifact_pipeline_fixture(
                    point_plan,
                    sample_index,
                    &internal_outputs,
                )
            },
        )
        .expect("tracking diagnostics should use physical field-axis tracking");
        let diagnostics: Value = serde_json::from_slice(
            artifact_bytes(&diagnostics_run, "eigen/diagnostics.v2.json")
                .expect("tracking diagnostics are published"),
        )
        .expect("tracking diagnostics JSON is valid");
        assert_eq!(
            diagnostics["samples"][0]["external_field_a_per_m"],
            serde_json::json!([100.0, 0.0, 0.0])
        );
        assert_eq!(
            diagnostics["samples"][1]["external_field_a_per_m"],
            serde_json::json!([200.0, 0.0, 0.0])
        );
        let records = diagnostics["tracking"]["data"]["records"]
            .as_array()
            .expect("tracking records are available");
        assert!(records.iter().any(|record| {
            record["branch_id"] == 0
                && record["sample_index"] == 0
                && record["raw_mode_index"] == 0
        }));
        assert!(records.iter().any(|record| {
            record["branch_id"] == 0
                && record["sample_index"] == 1
                && record["raw_mode_index"] == 1
        }));
        assert!(!diagnostics_run.auxiliary_artifacts.iter().any(|artifact| {
            artifact.relative_path.starts_with("eigen/modes/")
                || artifact.relative_path.starts_with("eigen/mode_fields/")
                || artifact.relative_path.starts_with("eigen/mode_fields.zarr/")
        }));

        let paused_prefix = crate::fem::eigen_sweep::execute_bias_field_sweep_with_publication(
            &plan,
            &outputs,
            FemEngine::CpuNative,
            true,
            |point_plan, sample_index| {
                let tracking_outputs = eigen_path_tracking_outputs(&outputs, plan.count);
                let mut run = bias_field_native_artifact_pipeline_fixture(
                    point_plan,
                    sample_index,
                    &tracking_outputs,
                )?;
                if sample_index == 1 {
                    run.result.status = RunStatus::Paused;
                    run.result.completion = Some(crate::relaxation::resolve_stage_completion(
                        RunStatus::Paused,
                        None,
                        crate::relaxation::RelaxationCompletionMetrics::default(),
                    ));
                }
                Ok(run)
            },
        )
        .expect("paused sweep should publish only its accepted tracked prefix");
        assert_eq!(paused_prefix.result.status, RunStatus::Paused);
        let prefix_spectrum: Value = serde_json::from_slice(
            artifact_bytes(&paused_prefix, "eigen/spectrum.v2.json")
                .expect("paused-prefix spectrum is published"),
        )
        .expect("paused-prefix spectrum JSON is valid");
        assert_eq!(prefix_spectrum["samples"].as_array().unwrap().len(), 1);
        assert_eq!(prefix_spectrum["samples"][0]["modes"][0]["raw_mode_index"], 0);
        let prefix_branches: Value = serde_json::from_slice(
            artifact_bytes(&paused_prefix, "eigen/branches.v2.json")
                .expect("paused-prefix branch table is published"),
        )
        .expect("paused-prefix branch table JSON is valid");
        assert_eq!(prefix_branches["branches"].as_array().unwrap().len(), 1);
        assert_eq!(prefix_branches["branches"][0]["points"].as_array().unwrap().len(), 1);
        assert!(!paused_prefix.auxiliary_artifacts.iter().any(|artifact| {
            artifact.relative_path.starts_with("eigen/modes/sample_0001/")
                || artifact.relative_path.starts_with("eigen/mode_fields/sample_0001/")
                || (artifact.relative_path.starts_with("eigen/metadata/sample_0001")
                    && artifact.relative_path.contains("_mode_"))
        }));

        let unknown_branch_outputs = vec![OutputIR::EigenMode {
            field: "mode".to_string(),
            all_modes: false,
            indices: Vec::new(),
            branches: vec![99],
            sample_selector: None,
        }];
        let unknown = crate::fem::eigen_sweep::execute_bias_field_sweep_with_publication(
            &plan,
            &unknown_branch_outputs,
            FemEngine::CpuNative,
            true,
            |point_plan, sample_index| {
                let unknown_tracking_outputs =
                    eigen_path_tracking_outputs(&unknown_branch_outputs, plan.count);
                bias_field_native_artifact_pipeline_fixture(
                    point_plan,
                    sample_index,
                    &unknown_tracking_outputs,
                )
            },
        )
        .expect_err("unknown tracked branch selection must fail closed");
        assert!(unknown.message.contains("invalid bias-field eigen output selection"));
    }

    fn test_bias_field_execution_resolution(
    ) -> fullmag_ir::FemEigenExecutionResolutionIR {
        fullmag_ir::FemEigenExecutionResolutionIR {
            requested_device: fullmag_ir::ExecutionDevice::Cpu,
            resolved_device: fullmag_ir::ExecutionDevice::Cpu,
            requested_precision: fullmag_ir::ExecutionPrecision::Double,
            resolved_precision: fullmag_ir::ExecutionPrecision::Double,
            requested_engine: fullmag_ir::FemEigenEngineIR::Auto,
            resolved_engine: fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            fallback_used: false,
            fallback_reason: None,
            selection_reason: "bias_field_branch_test".to_string(),
        }
    }
}

/// Parse one completed process-worker payload through the same spectrum,
/// mode-vector and seam contracts as the in-process path.  The worker only
/// owns native execution and artifact production; branch tracking remains in
/// this parent process so completion order cannot change branch identities.
pub(crate) fn parse_worker_single_k_result(
    plan: &FemEigenPlanIR,
    point_plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    sample: &KSampleDescriptor,
    engine: FemEngine,
    artifacts: &[AuxiliaryArtifact],
    tracking_topology: &MeshTopology,
    tracking_reduction: &ReductionMap,
    tracking_metric: &std::sync::Arc<crate::eigen::types::ConsistentP1TrackingMetric>,
) -> Result<(SingleKSolveResult, Vec<AuxiliaryArtifact>), RunError> {
    let spectrum_bytes = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/spectrum.json")
        .map(|artifact| &artifact.bytes)
        .ok_or_else(|| RunError {
            message: "single-k worker did not produce eigen/spectrum.json".to_string(),
        })?;
    let spectrum: Value = serde_json::from_slice(spectrum_bytes).map_err(|error| RunError {
        message: format!("failed to parse worker spectrum.json: {error}"),
    })?;
    let relaxation_steps = spectrum["relaxation_steps"].as_u64().unwrap_or(0);
    let solver_kind = spectrum["solver_kind"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let modes_array = spectrum["modes"].as_array().ok_or_else(|| RunError {
        message: "worker spectrum.json has no modes array".to_string(),
    })?;
    if modes_array.is_empty() {
        return Err(RunError {
            message: format!(
                "worker spectrum.json sample={} has no accepted modes",
                sample.sample_index
            ),
        });
    }
    let native_mode_identities =
        eigen_path_native_mode_identities(modes_array, sample.sample_index)?;
    let available_mode_indices = native_mode_identities
        .iter()
        .map(|(raw, _)| {
            u32::try_from(*raw).map_err(|_| RunError {
                message: "native raw mode identity exceeds output selector range".to_string(),
            })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let published = eigen_path_candidate_mode_indices(outputs, sample, &available_mode_indices);
    let mode_artifacts = remap_single_k_mode_artifacts(artifacts, sample.sample_index, &published)?;
    let tracking_active_nodes = tracking_metric.node_indices();
    let mut modes = Vec::with_capacity(modes_array.len());
    for (mode_json, (raw_mode_index, frequency_real_hz)) in
        modes_array.iter().zip(native_mode_identities)
    {
        let solver_device = if engine == FemEngine::NativeGpu {
            "gpu"
        } else {
            "cpu"
        };
        let component_participation = eigen_path_component_participation_from_json(
            mode_json.get("component_participation"),
            solver_device,
        )?;
        modes.push(SingleKModeResult {
            raw_mode_index,
            branch_id: None,
            frequency_real_hz,
            frequency_imag_hz: mode_json["frequency_imag_hz"].as_f64().unwrap_or(0.0),
            angular_frequency_rad_per_s: mode_json["angular_frequency_rad_per_s"]
                .as_f64()
                .unwrap_or(0.0),
            eigenvalue_real: mode_json["eigenvalue_real"].as_f64().unwrap_or(0.0),
            eigenvalue_imag: mode_json["eigenvalue_imag"].as_f64().unwrap_or(0.0),
            norm: mode_json["norm"].as_f64().unwrap_or(0.0),
            mass_norm: mode_json["mass_norm"].as_f64(),
            max_amplitude: mode_json["max_amplitude"].as_f64().unwrap_or(0.0),
            residual_relative_l2: mode_json["residual_relative_l2"].as_f64(),
            residual_norm: mode_json["residual_norm"].as_f64(),
            residual_linf: mode_json["residual_linf"].as_f64(),
            tangent_leakage_mean_abs: mode_json["tangent_leakage_mean_abs"].as_f64(),
            tangent_leakage_max_abs: mode_json["tangent_leakage_max_abs"].as_f64(),
            tangent_leakage_weighted_relative_l2: mode_json
                .get("tangent_leakage_weighted_relative_l2")
                .and_then(Value::as_f64),
            dominant_polarization: mode_json["dominant_polarization"]
                .as_str()
                .unwrap_or("unknown")
                .to_string(),
            reduced_vector: eigen_path_mode_tracking_vector(
                artifacts,
                raw_mode_index,
                Some(tracking_active_nodes),
                &tracking_topology.coords,
                sample.k_vector,
                matches!(
                    point_plan.spin_wave_bc.kind(),
                    fullmag_ir::SpinWaveBoundaryKindIR::Floquet
                ),
                tracking_metric.mesh_identity(),
            )?,
            lifted_real: None,
            lifted_imag: None,
            amplitude: None,
            phase: None,
            node_mass_weights: None,
            consistent_p1_metric: Some(tracking_metric.clone()),
            component_participation,
        });
    }
    let mut seam_records = Vec::new();
    if matches!(
        point_plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic | fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        for mode in &modes {
            if let Some(vector) = mode.reduced_vector.as_deref() {
                if let Some((checked_nodes, relative)) = tracking_metric
                    .periodic_seam_relative(
                        vector,
                        &tracking_topology.coords,
                        sample.k_vector,
                        &tracking_reduction.node_map,
                        &tracking_reduction.active_nodes,
                        &tracking_reduction.node_phases,
                    )
                    .map_err(|message| RunError { message })?
                {
                    seam_records.push(serde_json::json!({
                        "definition_id": "magnetic_cartesian_periodic_seam_max_relative.v1",
                        "sample_index": sample.sample_index,
                        "raw_mode_index": mode.raw_mode_index,
                        "frequency_hz": mode.frequency_real_hz,
                        "k_vector": sample.k_vector,
                        "source_mesh_topology_sha256": tracking_metric.mesh_identity(),
                        "checked_slave_node_count": checked_nodes,
                        "max_relative_mismatch": relative,
                        "scope": "magnetic_cartesian_field_only",
                        "execution_lane": "postprocess_cpu",
                    }));
                }
            }
        }
    }
    let mut solver_diagnostics = spectrum.get("solver_diagnostics").cloned();
    if let Some(diagnostics) = solver_diagnostics.as_mut().and_then(Value::as_object_mut) {
        let records = modes_array
            .iter()
            .filter_map(|native_mode| {
                let blocks = native_mode.get("block_residuals")?;
                Some(serde_json::json!({
                    "sample_index": sample.sample_index,
                    "raw_mode_index": native_mode["index"],
                    "frequency_hz": native_mode["frequency_real_hz"],
                    "block_residuals": blocks,
                }))
            })
            .collect::<Vec<_>>();
        diagnostics.insert(
            "mode_periodic_seam_measurements".into(),
            Value::Array(seam_records),
        );
        diagnostics.insert(
            "tracking_mass_metric".into(),
            serde_json::json!({
                "definition_id": "consistent_p1_tet4_cartesian_nodal_envelope.v1",
                "source_mesh_topology_sha256": tracking_metric.mesh_identity(),
                "physical_magnetic_node_count": tracking_active_nodes.len(),
                "projection_scope": "nodal_P1_envelope",
                "execution_lane": "postprocess_cpu",
                "qualification": "runtime_unqualified"
            }),
        );
        diagnostics.insert("native_mode_block_residuals".into(), Value::Array(records));
    }
    Ok((
        SingleKSolveResult {
            sample: sample.clone(),
            modes,
            relaxation_steps,
            solver_model: eigen_path_single_k_solver_model(point_plan, artifacts),
            solver_notes: vec![solver_kind],
            solver_diagnostics,
        },
        mode_artifacts,
    ))
}

/// Track the accepted bias-field sample prefix from the publisher's complete
/// single-k artifacts, then bind selection and field artifacts to those real
/// branch identities.  The KSampleDescriptor is an internal Gamma sample key;
/// the published sweep axis remains the declared physical field vector.
pub(super) fn track_bias_field_sweep_samples(
    plan: &FemEigenPlanIR,
    sample_plans: &[FemEigenPlanIR],
    outputs: &[OutputIR],
    engine: FemEngine,
    runs: &mut [ExecutedRun],
) -> Result<(), RunError> {
    if sample_plans.len() != runs.len() {
        return Err(RunError {
            message: format!(
                "bias-field tracking has {} sample plans for {} publisher runs",
                sample_plans.len(),
                runs.len()
            ),
        });
    }
    let completed_count = runs
        .iter()
        .take_while(|run| run.result.status == RunStatus::Completed)
        .count();
    if runs
        .iter()
        .skip(completed_count)
        .any(|run| run.result.status == RunStatus::Completed)
    {
        return Err(RunError {
            message: "bias-field tracking requires one completed sample prefix".to_string(),
        });
    }
    if completed_count == 0 {
        return Ok(());
    }

    let authored_k_vector = match plan.k_sampling.as_ref() {
        Some(fullmag_ir::KSamplingIR::Single { k_vector }) => *k_vector,
        _ => {
            return Err(RunError {
                message: "bias-field tracking requires the declared single-k sample".to_string(),
            });
        }
    };
    let tracking_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("bias-field tracking mesh topology: {error}"),
    })?;
    let tracking_reduction =
        build_reduction_map(&tracking_topology, &plan.spin_wave_bc, plan.k_sampling.as_ref())?;
    let tracking_metric = eigen_path_consistent_tracking_metric(&tracking_topology, &plan.mesh)?;
    let tracking_outputs = eigen_path_tracking_outputs(outputs, plan.count);
    let mut samples = Vec::with_capacity(completed_count);
    let mut mode_artifacts = Vec::new();

    for sample_index in 0..completed_count {
        let declared_sample = plan
            .bias_field_samples
            .get(sample_index)
            .ok_or_else(|| RunError {
                message: format!("bias-field tracking has no declared sample {sample_index}"),
            })?;
        let point_plan = &sample_plans[sample_index];
        if point_plan.external_field != Some(declared_sample.field_a_per_m) {
            return Err(RunError {
                message: format!(
                    "bias-field sample {sample_index} publisher plan does not retain the declared field axis"
                ),
            });
        }
        let sample = KSampleDescriptor {
            sample_index: declared_sample.sample_index as usize,
            label: None,
            segment_index: None,
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: authored_k_vector,
        };
        let (parsed, published_mode_artifacts) = parse_worker_single_k_result(
            plan,
            point_plan,
            &tracking_outputs,
            &sample,
            engine,
            &runs[sample_index].auxiliary_artifacts,
            &tracking_topology,
            &tracking_reduction,
            &tracking_metric,
        )?;
        samples.push(parsed);
        mode_artifacts.extend(published_mode_artifacts);
    }

    let solver_model = samples
        .first()
        .map(|sample| sample.solver_model)
        .ok_or_else(|| RunError {
            message: "bias-field tracking parsed no accepted publisher samples".to_string(),
        })?;
    if samples
        .iter()
        .any(|sample| sample.solver_model != solver_model)
    {
        return Err(RunError {
            message: "bias-field samples resolved different eigen solver models".to_string(),
        });
    }
    let mut path_result = crate::eigen::PathSolveResult {
        gamma0_rad_s_per_a_m: plan.gyromagnetic_ratio,
        samples,
        branches: Vec::new(),
        solver_model,
        notes: Vec::new(),
        include_demag: plan.operator.include_demag,
        dispersion_validation: plan.dispersion_validation.clone(),
        k0_kittel_validation: plan.k0_kittel_validation.clone(),
        solver_policy: plan.solver_policy.clone(),
        dispersion_analytic_reference: None,
        k0_kittel_periodic_airbox_demag: None,
    };
    path_result.notes = path_result
        .samples
        .iter()
        .flat_map(|sample| sample.solver_notes.iter().cloned())
        .collect();
    crate::eigen::track_branches(&mut path_result, plan.mode_tracking.as_ref());

    let selection = select_eigen_outputs(&path_result, outputs).map_err(|error| RunError {
        message: format!("invalid bias-field eigen output selection: {error}"),
    })?;
    let published_mode_ids = selection
        .spectrum_mode_ids()
        .union(selection.field_mode_ids())
        .copied()
        .collect::<BTreeSet<_>>();
    let actual_mode_ids = path_result
        .samples
        .iter()
        .flat_map(|sample| {
            sample.modes.iter().map(|mode| {
                SampleModeId::new(sample.sample.sample_index, mode.raw_mode_index)
            })
        })
        .collect::<BTreeSet<_>>();
    let sample_descriptors = path_result
        .samples
        .iter()
        .map(|sample| sample.sample.clone())
        .collect::<Vec<_>>();
    materialize_selected_path_physical_potential_artifacts(
        plan,
        &sample_descriptors,
        &actual_mode_ids,
        selection.field_mode_ids(),
        &mut mode_artifacts,
    )?;
    retain_selected_eigen_path_mode_artifacts(&mut mode_artifacts, selection.field_mode_ids());
    validate_eigen_path_selected_mode_artifacts(&mode_artifacts, selection.field_mode_ids())?;
    bind_eigen_path_tracked_mode_metadata(&mut mode_artifacts, &path_result)?;

    let branches_payload = bias_field_sweep_branches_payload(
        plan,
        &path_result,
        &selection,
        &published_mode_ids,
        authored_k_vector,
    );
    let legacy_branches_payload = serde_json::json!({
        "schema_version": "2",
        "tracking_policy_availability": branches_payload["tracking_policy_availability"],
        "solver_model": path_result.solver_model.as_str(),
        "tracking_method": branches_payload["tracking_method"],
        "overlap_floor": branches_payload["overlap_floor"],
        "frequency_window_hz": branches_payload["frequency_window_hz"],
        "branches": branches_payload["branches"],
    });
    let diagnostics_payload = selection.diagnostics_request().map(|request| {
        let samples = path_result
            .samples
            .iter()
            .map(|sample| {
                let modes = sample
                    .modes
                    .iter()
                    .filter(|mode| {
                        request.any_enabled()
                            && selection
                                .diagnostic_mode_ids()
                                .contains(&SampleModeId::new(
                                    sample.sample.sample_index,
                                    mode.raw_mode_index,
                                ))
                    })
                    .map(|mode| {
                        EigenDiagnosticModeRecord::from_mode(
                            sample.sample.sample_index,
                            mode,
                        )
                    })
                    .collect();
                EigenDiagnosticSampleRecord {
                    sample_index: sample.sample.sample_index,
                    computed_mode_count: sample.modes.len(),
                    modes,
                    mass_orthogonality: canonical_mass_orthogonality_rows(
                        sample.solver_diagnostics.as_ref(),
                        sample.sample.sample_index,
                    ),
                }
            })
            .collect::<Vec<_>>();
        let transport = eigen_path_diagnostics_transport_metadata(&path_result, Some(plan));
        let mut diagnostics = build_eigen_diagnostics_v2(
            path_result.solver_model.as_str(),
            "bias_field_sweep_orchestrator",
            &samples,
            &path_result.branches,
            request,
            Some(plan.count as usize),
            Some(&transport),
        );
        diagnostics["samples"] = Value::Array(
            path_result
                .samples
                .iter()
                .map(|sample| {
                    serde_json::json!({
                        "sample_index": sample.sample.sample_index,
                        "sample_id": eigen_path_sample_id_for_index(
                            plan,
                            sample.sample.sample_index,
                        ),
                        "external_field_a_per_m": plan.bias_field_samples
                            [sample.sample.sample_index]
                            .field_a_per_m,
                        "computed_mode_count": sample.modes.len(),
                    })
                })
                .collect(),
        );
        for section in ["tracking", "overlaps", "residuals", "tangent_leakage", "orthogonality"] {
            let Some(records) = diagnostics
                .get_mut(section)
                .and_then(|value| value.get_mut("data"))
                .and_then(|value| value.get_mut("records"))
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            for record in records {
                let Some(sample_index) = record
                    .get("sample_index")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                else {
                    continue;
                };
                if let Some(declared_sample) = plan.bias_field_samples.get(sample_index) {
                    record["sample_id"] = serde_json::json!(eigen_path_sample_id_for_index(
                        plan,
                        sample_index,
                    ));
                    record["external_field_a_per_m"] =
                        serde_json::json!(declared_sample.field_a_per_m);
                }
            }
        }
        diagnostics
    });

    for sample_index in 0..completed_count {
        let sample_result = &path_result.samples[sample_index];
        let original_spectrum = bias_field_sweep_sample_modes(
            &runs[sample_index],
            "eigen/spectrum.v2.json",
            sample_result.sample.sample_index,
        )?;
        let mut modes_v2 = Vec::new();
        let mut modes_v3 = Vec::new();
        for mode in &sample_result.modes {
            let mode_id = SampleModeId::new(sample_result.sample.sample_index, mode.raw_mode_index);
            if !published_mode_ids.contains(&mode_id) {
                continue;
            }
            let original = original_spectrum
                .iter()
                .find(|candidate| bias_field_raw_mode_index(candidate) == Some(mode.raw_mode_index))
                .ok_or_else(|| RunError {
                    message: format!(
                        "bias-field sample {} publisher spectrum is missing raw mode {}",
                        sample_result.sample.sample_index, mode.raw_mode_index
                    ),
                })?;
            let (mode_v2, mode_v3) = bias_field_tracked_mode_publications(
                plan,
                sample_result,
                mode,
                path_result.solver_model,
                selection.contains_field_mode(
                    sample_result.sample.sample_index,
                    mode.raw_mode_index,
                ),
                original,
                &path_result,
            )?;
            modes_v2.push(mode_v2);
            modes_v3.push(mode_v3);
        }
        let declared_field = plan.bias_field_samples[sample_index].field_a_per_m;
        replace_bias_field_sample_spectrum(
            &mut runs[sample_index],
            "eigen/spectrum.v2.json",
            sample_result.sample.sample_index,
            eigen_path_sample_id_for_index(plan, sample_result.sample.sample_index),
            declared_field,
            authored_k_vector,
            &modes_v2,
        )?;
        replace_bias_field_sample_spectrum(
            &mut runs[sample_index],
            "eigen/spectrum.v3.json",
            sample_result.sample.sample_index,
            eigen_path_sample_id_for_index(plan, sample_result.sample.sample_index),
            declared_field,
            authored_k_vector,
            &modes_v3,
        )?;
        for path in ["eigen/spectrum.json", "eigen/metadata/eigen_summary.json"] {
            replace_bias_field_summary_modes(
                &mut runs[sample_index],
                path,
                &modes_v3,
                declared_field,
            )?;
        }
        runs[sample_index].auxiliary_artifacts.retain(|artifact| {
            artifact.relative_path != "eigen/branches.v2.json"
                && artifact.relative_path != "eigen/branches.json"
                && !artifact.relative_path.starts_with("eigen/modes/")
                && !artifact.relative_path.starts_with("eigen/mode_fields/")
                && !artifact.relative_path.starts_with("eigen/mode_fields.zarr/")
        });
    }

    for artifact in mode_artifacts {
        let sample_index = bias_field_artifact_sample_index(&artifact.relative_path)
            .filter(|sample_index| *sample_index < completed_count)
            .unwrap_or(0);
        runs[sample_index].auxiliary_artifacts.push(artifact);
    }
    for run in runs.iter_mut().take(completed_count) {
        deduplicate_auxiliary_artifacts_by_path(&mut run.auxiliary_artifacts)?;
    }
    if let Some(first_run) = runs.first_mut() {
        first_run.auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/branches.v2.json".to_string(),
            bytes: serde_json::to_vec_pretty(&branches_payload).map_err(|error| RunError {
                message: format!("failed to serialize tracked bias-field branches: {error}"),
            })?,
        });
        first_run.auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/branches.json".to_string(),
            bytes: serde_json::to_vec_pretty(&legacy_branches_payload).map_err(|error| {
                RunError {
                    message: format!("failed to serialize legacy bias-field branches: {error}"),
                }
            })?,
        });
        if let Some(diagnostics) = diagnostics_payload {
            first_run.auxiliary_artifacts.push(AuxiliaryArtifact {
                relative_path: "eigen/diagnostics.v2.json".to_string(),
                bytes: serde_json::to_vec_pretty(&diagnostics).map_err(|error| RunError {
                    message: format!(
                        "failed to serialize bias-field tracking diagnostics: {error}"
                    ),
                })?,
            });
        }
    }
    Ok(())
}

fn bias_field_sweep_sample_modes(
    run: &ExecutedRun,
    path: &str,
    sample_index: usize,
) -> Result<Vec<Value>, RunError> {
    let artifact = run
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == path)
        .ok_or_else(|| RunError {
            message: format!("bias-field sample is missing {path}"),
        })?;
    let value: Value = serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
        message: format!("cannot parse {path} from bias-field sample: {error}"),
    })?;
    let samples = value["samples"].as_array().ok_or_else(|| RunError {
        message: format!("{path} has no samples array"),
    })?;
    let mut matching = samples.iter().filter(|sample| {
        sample["sample_index"].as_u64() == Some(sample_index as u64)
    });
    let sample = matching.next().ok_or_else(|| RunError {
        message: format!("{path} has no sample {sample_index}"),
    })?;
    if matching.next().is_some() {
        return Err(RunError {
            message: format!("{path} repeats sample {sample_index}"),
        });
    }
    sample["modes"]
        .as_array()
        .cloned()
        .ok_or_else(|| RunError {
            message: format!("{path} sample {sample_index} has no modes array"),
        })
}

fn bias_field_raw_mode_index(mode: &Value) -> Option<usize> {
    mode.get("raw_mode_index")
        .or_else(|| mode.get("index"))
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
}

fn bias_field_tracked_mode_publications(
    plan: &FemEigenPlanIR,
    sample: &SingleKSolveResult,
    mode: &SingleKModeResult,
    solver_model: crate::eigen::EigenSolverModel,
    field_selected: bool,
    original_mode: &Value,
    path_result: &crate::eigen::PathSolveResult,
) -> Result<(Value, Value), RunError> {
    let tracked = path_result
        .branches
        .iter()
        .find_map(|branch| {
            branch.points.iter().enumerate().find_map(|(point_index, point)| {
                (point.sample_index == sample.sample.sample_index
                    && point.raw_mode_index == mode.raw_mode_index)
                    .then_some((branch, point_index, point))
            })
        })
        .ok_or_else(|| RunError {
            message: format!(
                "bias-field tracker omitted sample {} raw mode {}",
                sample.sample.sample_index, mode.raw_mode_index
            ),
        })?;
    let field_id = original_mode
        .get("mode_field_id")
        .and_then(Value::as_str);
    let field_resource_key = original_mode
        .get("mode_field_resource_key")
        .and_then(Value::as_str);
    if field_selected && (field_id.is_none() || field_resource_key.is_none()) {
        return Err(RunError {
            message: format!(
                "selected bias-field sample {} raw mode {} lacks a complete publisher field reference",
                sample.sample.sample_index, mode.raw_mode_index
            ),
        });
    }
    let mut mode_v2 = eigen_path_mode_json(
        plan,
        &sample.sample,
        mode,
        solver_model,
        sample.solver_diagnostics.as_ref(),
    );
    let mut mode_v3 = eigen_path_mode_v3_json(
        plan,
        &sample.sample,
        mode,
        solver_model,
        sample.solver_diagnostics.as_ref(),
    );
    let tracking_score_source = eigen_path_branch_point_tracking_score_source(
        path_result,
        tracked.0,
        tracked.1,
    );
    let modal_overlap_available = eigen_path_branch_point_modal_overlap_available(
        path_result,
        tracked.0,
        tracked.1,
    );
    for publication in [&mut mode_v2, &mut mode_v3] {
        publication["external_field_a_per_m"] = serde_json::json!(plan.bias_field_samples
            [sample.sample.sample_index]
            .field_a_per_m);
        publication["k_vector"] = serde_json::json!(sample.sample.k_vector);
        publication["branch_id"] = serde_json::json!(tracked.0.branch_id);
        publication["mode_id"] = serde_json::json!(eigen_path_mode_id(
            sample.sample.sample_index,
            mode.raw_mode_index
        ));
        publication["tracking_confidence"] = serde_json::json!(tracked.2.tracking_confidence);
        publication["overlap_prev"] = serde_json::json!(tracked.2.overlap_prev);
        publication["tracking_edge"] = serde_json::to_value(&tracked.2.tracking_edge).map_err(
            |error| RunError {
                message: format!("cannot serialize bias-field tracking edge: {error}"),
            },
        )?;
        publication["tracking_score_source"] = serde_json::json!(tracking_score_source);
        publication["modal_overlap_available"] = serde_json::json!(modal_overlap_available);
        publication["mode_field_available"] = serde_json::json!(field_selected);
        if field_selected {
            publication["mode_field_id"] = serde_json::json!(field_id);
            publication["mode_field_resource_key"] = serde_json::json!(field_resource_key);
        } else if let Some(object) = publication.as_object_mut() {
            object.remove("mode_field_id");
            object.remove("mode_field_resource_key");
        }
    }
    Ok((mode_v2, mode_v3))
}

fn replace_bias_field_sample_spectrum(
    run: &mut ExecutedRun,
    path: &str,
    sample_index: usize,
    sample_id: String,
    external_field_a_per_m: [f64; 3],
    k_vector: [f64; 3],
    modes: &[Value],
) -> Result<(), RunError> {
    let artifact = run
        .auxiliary_artifacts
        .iter_mut()
        .find(|artifact| artifact.relative_path == path)
        .ok_or_else(|| RunError {
            message: format!("bias-field sample is missing {path}"),
        })?;
    let mut value: Value = serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
        message: format!("cannot parse {path} from bias-field sample: {error}"),
    })?;
    let samples = value
        .get_mut("samples")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| RunError {
            message: format!("{path} has no samples array"),
        })?;
    let mut matching = samples
        .iter_mut()
        .filter(|sample| sample["sample_index"].as_u64() == Some(sample_index as u64));
    let sample = matching.next().ok_or_else(|| RunError {
        message: format!("{path} has no sample {sample_index}"),
    })?;
    if matching.next().is_some() {
        return Err(RunError {
            message: format!("{path} repeats sample {sample_index}"),
        });
    }
    sample["sample_id"] = serde_json::json!(sample_id);
    sample["label"] = Value::Null;
    sample["k_vector"] = serde_json::json!(k_vector);
    sample["path_s"] = serde_json::json!(0.0);
    sample["segment_index"] = Value::Null;
    sample["t_in_segment"] = Value::Null;
    sample["external_field_a_per_m"] = serde_json::json!(external_field_a_per_m);
    sample["modes"] = Value::Array(modes.to_vec());
    let sample_count = samples.len();
    value["sample_count"] = serde_json::json!(sample_count);
    value["mode_count"] = serde_json::json!(modes.len());
    artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
        message: format!("cannot serialize tracked {path}: {error}"),
    })?;
    Ok(())
}

fn replace_bias_field_summary_modes(
    run: &mut ExecutedRun,
    path: &str,
    modes: &[Value],
    external_field_a_per_m: [f64; 3],
) -> Result<(), RunError> {
    let artifact = run
        .auxiliary_artifacts
        .iter_mut()
        .find(|artifact| artifact.relative_path == path)
        .ok_or_else(|| RunError {
            message: format!("bias-field sample is missing {path}"),
        })?;
    let mut value: Value = serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
        message: format!("cannot parse {path} from bias-field sample: {error}"),
    })?;
    let object = value.as_object_mut().ok_or_else(|| RunError {
        message: format!("{path} must be a JSON object"),
    })?;
    object.insert("modes".to_string(), Value::Array(modes.to_vec()));
    object.insert("mode_count".to_string(), serde_json::json!(modes.len()));
    object.insert(
        "external_field_a_per_m".to_string(),
        serde_json::json!(external_field_a_per_m),
    );
    artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
        message: format!("cannot serialize tracked {path}: {error}"),
    })?;
    Ok(())
}

fn bias_field_artifact_sample_index(path: &str) -> Option<usize> {
    path.split('/').find_map(|component| {
        let suffix = component.strip_prefix("sample_")?;
        let digits = suffix
            .find(|character: char| !character.is_ascii_digit())
            .unwrap_or(suffix.len());
        (digits > 0).then(|| suffix[..digits].parse::<usize>().ok()).flatten()
    })
}

fn bias_field_sweep_branches_payload(
    plan: &FemEigenPlanIR,
    result: &crate::eigen::PathSolveResult,
    selection: &EigenOutputSelection,
    published_mode_ids: &BTreeSet<SampleModeId>,
    k_vector: [f64; 3],
) -> Value {
    let overlap_values = eigen_path_overlap_values(result, selection);
    let min_overlap = overlap_values
        .iter()
        .copied()
        .reduce(|left, right| left.min(right));
    let median_overlap = median_f64(&overlap_values);
    let (tracking_score_source, modal_overlap_available) =
        eigen_path_tracking_score_summary(result);
    let unavailable_reason = if modal_overlap_available {
        Value::Null
    } else if result.branches.iter().flat_map(|branch| &branch.points).any(|point| {
        point.tracking_edge.as_ref().is_some_and(|edge| {
            matches!(edge.transition, crate::eigen::types::TrackingTransition::NewBranch)
        })
    }) {
        serde_json::json!("tracking_restart_without_predecessor")
    } else if tracking_score_source == "frequency_score_fallback" {
        serde_json::json!("mode_vectors_unavailable")
    } else {
        serde_json::json!("tracking_metric_or_edge_evidence_unavailable")
    };
    let gap_count = result
        .branches
        .iter()
        .map(|branch| result.samples.len().saturating_sub(branch.points.len()))
        .sum::<usize>();
    let branches = result
        .branches
        .iter()
        .filter_map(|branch| {
            let points = branch
                .points
                .iter()
                .enumerate()
                .filter(|(_, point)| {
                    published_mode_ids.contains(&SampleModeId::new(
                        point.sample_index,
                        point.raw_mode_index,
                    ))
                })
                .map(|(point_index, point)| {
                    let mode = eigen_path_mode_for_branch_point(result, point);
                    let field_available =
                        selection.contains_field_mode(point.sample_index, point.raw_mode_index);
                    serde_json::json!({
                        "sample_id": eigen_path_sample_id_for_index(plan, point.sample_index),
                        "mode_id": eigen_path_mode_id(point.sample_index, point.raw_mode_index),
                        "sample_index": point.sample_index,
                        "external_field_a_per_m": plan.bias_field_samples[point.sample_index].field_a_per_m,
                        "k_vector": k_vector,
                        "raw_mode_index": point.raw_mode_index,
                        "frequency_hz": point.frequency_real_hz,
                        "frequency_real_hz": point.frequency_real_hz,
                        "frequency_imag_hz": point.frequency_imag_hz,
                        "angular_frequency_rad_per_s": mode
                            .map(|mode| mode.angular_frequency_rad_per_s)
                            .unwrap_or(point.frequency_real_hz * std::f64::consts::TAU),
                        "tracking_confidence": point.tracking_confidence,
                        "overlap_prev": point.overlap_prev,
                        "tracking_edge": point.tracking_edge,
                        "tracking_score_source": eigen_path_branch_point_tracking_score_source(
                            result,
                            branch,
                            point_index,
                        ),
                        "modal_overlap_available": eigen_path_branch_point_modal_overlap_available(
                            result,
                            branch,
                            point_index,
                        ),
                        "residual_norm": mode.and_then(|mode| mode.residual_norm),
                        "residual_linf": mode.and_then(|mode| mode.residual_linf),
                        "tangent_leakage_mean_abs": mode.and_then(|mode| mode.tangent_leakage_mean_abs),
                        "tangent_leakage_max_abs": mode.and_then(|mode| mode.tangent_leakage_max_abs),
                        "tangent_leakage_weighted_relative_l2": mode.and_then(|mode| mode.tangent_leakage_weighted_relative_l2),
                        "mode_field_id": if field_available {
                            Some(eigen_path_mode_field_id(point.sample_index, point.raw_mode_index))
                        } else {
                            None
                        },
                        "mode_field_available": field_available,
                    })
                })
                .collect::<Vec<_>>();
            (!points.is_empty()).then(|| {
                serde_json::json!({
                    "branch_id": branch.branch_id,
                    "label": branch.label,
                    "points": points,
                })
            })
        })
        .collect::<Vec<_>>();
    let recorded_policy = crate::eigen::tracking::recorded_tracking_policy(result);
    let policy_availability = if recorded_policy.is_some() {
        "complete"
    } else {
        "missing_or_mixed"
    };
    serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "tracking_policy_availability": policy_availability,
        "tracking_method": recorded_policy.map(|policy| policy.method),
        "tracking_score_source": tracking_score_source,
        "modal_overlap_available": modal_overlap_available,
        "overlap_floor": recorded_policy.map(|policy| policy.overlap_floor),
        "frequency_window_hz": recorded_policy.and_then(|policy| policy.frequency_window_hz),
        "branches": branches,
        "diagnostics": {
            "min_overlap": min_overlap,
            "median_overlap": median_overlap,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": unavailable_reason,
            "gap_count": gap_count,
            "ambiguous_assignment_count": Option::<u64>::None,
            "ambiguous_assignment_count_available": false,
            "ambiguous_assignment_count_unavailable_reason": "assignment_ambiguity_metric_not_computed",
        },
    })
}

/// Validate the minimum accepted-mode contract before a process result can
/// participate in adaptive-resource calibration.  The full parser below
/// still performs tracking/seam validation, but calibration must never be
/// unlocked by a completed process that only emitted an empty spectrum.
pub(crate) fn validate_worker_spectrum_artifact(
    artifacts: &[AuxiliaryArtifact],
    sample_index: usize,
) -> Result<(), RunError> {
    let spectrum_bytes = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/spectrum.json")
        .map(|artifact| &artifact.bytes)
        .ok_or_else(|| RunError {
            message: "single-k worker did not produce eigen/spectrum.json".to_string(),
        })?;
    let spectrum: Value = serde_json::from_slice(spectrum_bytes).map_err(|error| RunError {
        message: format!("failed to parse worker spectrum.json: {error}"),
    })?;
    let modes_array = spectrum["modes"].as_array().ok_or_else(|| RunError {
        message: "worker spectrum.json has no modes array".to_string(),
    })?;
    if modes_array.is_empty() {
        return Err(RunError {
            message: format!("worker spectrum.json sample={sample_index} has no accepted modes"),
        });
    }
    let _ = eigen_path_native_mode_identities(modes_array, sample_index)?;
    Ok(())
}

fn bind_eigen_path_handoff_diagnostics(
    diagnostics: &mut serde_json::Value,
    sample_index: usize,
    handoff_sha256: &str,
    handoff_source_mesh_topology_sha256: &str,
    modal_source_mesh_topology_sha256: &str,
) {
    let bind = |value: &mut serde_json::Value| {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "relax_to_eigen_handoff_sha256".to_string(),
                serde_json::json!(handoff_sha256),
            );
            object.insert(
                "relax_to_eigen_source_mesh_topology_sha256".to_string(),
                serde_json::json!(handoff_source_mesh_topology_sha256),
            );
            object.insert(
                "source_mesh_topology_sha256".to_string(),
                serde_json::json!(modal_source_mesh_topology_sha256),
            );
        }
    };

    bind(diagnostics);
    if let Some(samples) = diagnostics
        .get_mut("sample_solver_diagnostics")
        .and_then(serde_json::Value::as_array_mut)
    {
        for sample in samples {
            if sample
                .get("sample_index")
                .and_then(serde_json::Value::as_u64)
                == Some(sample_index as u64)
            {
                if let Some(nested) = sample.get_mut("diagnostics") {
                    bind(nested);
                }
            }
        }
    }
}

/// Multi-k orchestrator path: iterate over samples in a `KSamplingIR::Path`,
/// solve each point with the existing single-k solver, track branches, and
/// produce V2 path/branch/mode artifacts alongside legacy-compatible ones.
pub(crate) fn execute_fem_eigen_path(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    source_relax_handoff: Option<&fem_eigen::AcceptedFemRelaxStageHandoff>,
    progress: Option<&mut fem_eigen::FemEigenProgressCallback<'_>>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_path_with_producer_identity(
        execution,
        plan,
        outputs,
        source_relax_handoff,
        progress,
        None,
    )
}

pub(crate) fn execute_fem_eigen_path_with_producer_identity(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    source_relax_handoff: Option<&fem_eigen::AcceptedFemRelaxStageHandoff>,
    progress: Option<&mut fem_eigen::FemEigenProgressCallback<'_>>,
    producer_identity: Option<&fem_eigen::FemRelaxationProducerStageIdentity>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_path_with_producer_identity_and_parallel_policy(
        execution,
        plan,
        outputs,
        source_relax_handoff,
        progress,
        producer_identity,
        &ParallelExecutionPolicyIR::default(),
        None,
    )
}

pub(crate) fn execute_fem_eigen_path_with_producer_identity_and_parallel_policy(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    source_relax_handoff: Option<&fem_eigen::AcceptedFemRelaxStageHandoff>,
    mut progress: Option<&mut fem_eigen::FemEigenProgressCallback<'_>>,
    producer_identity: Option<&fem_eigen::FemRelaxationProducerStageIdentity>,
    parallel_policy: &ParallelExecutionPolicyIR,
    process_root: Option<&Path>,
) -> Result<ExecutedRun, RunError> {
    reject_reference_solver_for_dispersion_validation(plan)?;
    crate::eigen::artifacts::validated_modal_gamma0(plan.gyromagnetic_ratio).map_err(|error| {
        RunError {
            message: error.to_string(),
        }
    })?;
    let engine = match execution.lane() {
        FemEigenExecutionLane::Cpu => FemEngine::CpuNative,
        FemEigenExecutionLane::Gpu => FemEngine::NativeGpu,
    };
    if engine == FemEngine::NativeGpu && !gpu_modal_k0_kittel_path_supported(plan) {
        return Err(gpu_modal_dispersion_path_unavailable_error(plan));
    }
    super::eigen_execution::validate_modal_solver_policy_admission(
        plan,
        engine == FemEngine::NativeGpu,
        true,
    )?;
    let native_cpu_floquet_demag_path =
        engine == FemEngine::CpuNative && native_cpu_modal_window_enabled(plan);
    if !(k0_kittel_synthetic_demag_factor_enabled(plan) && !bias_field_sweep_requested(plan))
        && !native_cpu_floquet_demag_path
    {
        fem_eigen::reject_unsupported_floquet_dynamic_demag(
            &plan.spin_wave_bc,
            plan.operator.include_demag,
        )?;
    }

    use crate::eigen::{
        run_path_or_single, KSampleDescriptor, SingleKModeResult, SingleKSolveResult, SingleKSolver,
    };
    use crate::types::AuxiliaryArtifact;
    use std::cell::RefCell;

    struct KSolverAdapter<'a, 'p, 'c> {
        progress: std::sync::Mutex<Option<&'p mut fem_eigen::FemEigenProgressCallback<'c>>>,
        execution: PlannedFemEigenExecution<'a>,
        engine: FemEngine,
        mode_artifacts: RefCell<Vec<AuxiliaryArtifact>>,
        checkpoint_root: Option<std::path::PathBuf>,
        publication_outputs: Vec<OutputIR>,
        tracking_metric:
            RefCell<Option<std::sync::Arc<crate::eigen::types::ConsistentP1TrackingMetric>>>,
        source_relax_handoff: Option<fem_eigen::AcceptedFemRelaxStageHandoff>,
        producer_identity: Option<fem_eigen::FemRelaxationProducerStageIdentity>,
        interrupted_single_k: RefCell<Option<InterruptedSingleK>>,
        previous_accepted_magnetization: RefCell<Option<Vec<[f64; 3]>>>,
        periodic_airbox_k0_metrics:
            RefCell<Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>>,
        precomputed: RefCell<HashMap<usize, PrecomputedSingleK>>,
        parallel_report: Option<crate::eigen::k_process_pool::ProcessPoolReportV1>,
    }

    impl SingleKSolver for KSolverAdapter<'_, '_, '_> {
        fn solve_single_k(
            &self,
            plan: &FemEigenPlanIR,
            outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveResult, crate::types::RunError> {
            {
                let mut sink = self.progress.lock().map_err(|_| RunError {
                    message: "eigen path progress callback lock poisoned".to_string(),
                })?;
                super::eigen_progress::emit_fem_eigen_progress(
                    &mut *sink,
                    fem_eigen::FemEigenProgress {
                        phase: "preparing_k_path_sample",
                        requested_modes: plan.count as usize,
                        ..Default::default()
                    },
                )?;
            }
            if k0_kittel_synthetic_demag_factor_enabled(plan) && plan.bias_field_samples.is_empty()
            {
                return solve_k0_kittel_synthetic_demag_factor_single_k(plan, sample);
            }

            if let Some(precomputed) = self.precomputed.borrow_mut().remove(&sample.sample_index) {
                if precomputed.final_magnetization.len() != plan.mesh.nodes.len()
                    || precomputed
                        .final_magnetization
                        .iter()
                        .flatten()
                        .any(|value| !value.is_finite())
                {
                    return Err(RunError {
                        message: format!(
                            "adaptive worker sample {} did not produce a finite accepted equilibrium",
                            sample.sample_index
                        ),
                    });
                }
                if let Some(metrics) =
                    eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(
                        plan,
                        &precomputed.mode_artifacts,
                    )?
                {
                    eigen_path_merge_periodic_airbox_k0_metrics(
                        &mut self.periodic_airbox_k0_metrics.borrow_mut(),
                        metrics,
                    )?;
                }
                self.mode_artifacts
                    .borrow_mut()
                    .extend(precomputed.mode_artifacts);
                *self.previous_accepted_magnetization.borrow_mut() =
                    Some(precomputed.final_magnetization);
                return Ok(precomputed.result);
            }

            let source_stage_handoff =
                relax_stage_handoff_for_path_sample(plan, self.source_relax_handoff.as_ref());
            let mut point_plan = eigen_path_single_k_point_plan(plan, sample, false, None)?;
            if bias_field_sweep_requested(plan) {
                let declared_sample = plan
                    .bias_field_samples
                    .get(sample.sample_index)
                    .ok_or_else(|| RunError {
                        message: format!(
                            "FEM bias_field_samples has no bias field for sample {}",
                            sample.sample_index
                        ),
                    })?;
                let prepared = super::eigen_sweep::prepare_bias_field_sample_plan(
                    plan,
                    declared_sample,
                    &plan.equilibrium_magnetization,
                    self.previous_accepted_magnetization.borrow().as_deref(),
                )?;
                // Keep the path's single-k/Floquet normalization while importing
                // the canonical sweep preparation's field and equilibrium seed.
                point_plan.external_field = prepared.external_field;
                point_plan.equilibrium = prepared.equilibrium;
                point_plan.equilibrium_magnetization = prepared.equilibrium_magnetization;
                point_plan.bias_field_samples = prepared.bias_field_samples;
                point_plan.k0_kittel_validation = prepared.k0_kittel_validation;
            }
            let tracking_topology =
                MeshTopology::from_ir(&point_plan.mesh).map_err(|error| RunError {
                    message: format!("eigen path tracking mesh topology: {error}"),
                })?;
            let tracking_reduction = build_reduction_map(
                &tracking_topology,
                &point_plan.spin_wave_bc,
                point_plan.k_sampling.as_ref(),
            )?;
            let expected_tracking_mesh =
                point_plan
                    .mesh
                    .mixed_topology_fingerprint_v3()
                    .map_err(|message| RunError {
                        message: format!("eigen path tracking mesh identity: {message}"),
                    })?;
            let cached_tracking_metric = self.tracking_metric.borrow().clone();
            let tracking_metric = match cached_tracking_metric {
                Some(metric) if metric.mesh_identity() != expected_tracking_mesh.as_str() => {
                    return Err(RunError {
                        message: "eigen path tracking mesh changed between samples".into(),
                    });
                }
                Some(metric) => metric,
                None => {
                    let metric = eigen_path_consistent_tracking_metric(
                        &tracking_topology,
                        &point_plan.mesh,
                    )?;
                    *self.tracking_metric.borrow_mut() = Some(metric.clone());
                    metric
                }
            };
            let tracking_active_nodes = tracking_metric.node_indices();
            // A non-sweep path consumes the immutable Relax-stage handoff for
            // every k point. A bias-field path owns a separate accepted
            // equilibrium and therefore takes the per-sample relaxation route
            // below instead of reusing a summary-only continuation.
            let progress_sink = &self.progress;
            // Keep cancellation and native EPS/KSP telemetry connected for every
            // path sample, including the first relax-stage continuation.
            let mut forward = |event| match progress_sink.lock() {
                Ok(mut sink) => sink
                    .as_deref_mut()
                    .map_or(crate::types::StepAction::Continue, |callback| {
                        callback(event)
                    }),
                Err(_) => crate::types::StepAction::Stop,
            };
            let potential_publication = EigenPathPotentialPublication {
                outputs: self.publication_outputs.clone(),
                sample_index: sample.sample_index,
                sample_label: sample.label.clone(),
            };
            let executed = super::eigen_execution::execute_fem_eigen_path_single_k(
                self.execution,
                &point_plan,
                outputs,
                &potential_publication,
                Some(&mut forward),
                sample.sample_index,
                Some(sample.sample_index),
                source_stage_handoff,
                self.producer_identity.as_ref(),
            )?;
            // Preserve raw bytes first; only a completed native run may be
            // parsed or become the next sample's accepted equilibrium.
            match checkpoint_and_admit_single_k(
                self.checkpoint_root.as_deref(),
                sample,
                &point_plan,
                &executed,
            )? {
                SingleKCheckpointAdmission::Completed => {}
                SingleKCheckpointAdmission::Interrupted(interrupted) => {
                    let status = interrupted.status;
                    *self.interrupted_single_k.borrow_mut() = Some(interrupted);
                    return Err(RunError {
                        message: format!(
                            "FEM eigen path sample {} ended with status {status:?}",
                            sample.sample_index
                        ),
                    });
                }
            }
            {
                let final_magnetization = &executed.result.final_magnetization;
                if final_magnetization.len() != plan.mesh.nodes.len()
                    || final_magnetization
                        .iter()
                        .flatten()
                        .any(|component| !component.is_finite())
                {
                    return Err(RunError {
                        message: format!(
                            "FEM eigen path sample {} did not produce a finite accepted equilibrium",
                            sample.sample_index
                        ),
                    });
                }
                *self.previous_accepted_magnetization.borrow_mut() =
                    Some(final_magnetization.clone());
            }
            if let Some(metrics) = eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(
                plan,
                &executed.auxiliary_artifacts,
            )? {
                eigen_path_merge_periodic_airbox_k0_metrics(
                    &mut self.periodic_airbox_k0_metrics.borrow_mut(),
                    metrics,
                )?;
            }
            // Parse the spectrum artifact to extract mode results
            let spectrum_bytes = executed
                .auxiliary_artifacts
                .iter()
                .find(|a| a.relative_path == "eigen/spectrum.json")
                .map(|a| &a.bytes)
                .ok_or_else(|| crate::types::RunError {
                    message: "single-k solver did not produce eigen/spectrum.json".to_string(),
                })?;
            let spectrum: serde_json::Value =
                serde_json::from_slice(spectrum_bytes).map_err(|e| crate::types::RunError {
                    message: format!("failed to parse spectrum.json: {e}"),
                })?;
            let relaxation_steps = spectrum["relaxation_steps"].as_u64().unwrap_or(0);
            let solver_kind = spectrum["solver_kind"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();

            let modes_array =
                spectrum["modes"]
                    .as_array()
                    .ok_or_else(|| crate::types::RunError {
                        message: "spectrum.json has no modes array".to_string(),
                    })?;
            let native_mode_identities =
                eigen_path_native_mode_identities(modes_array, sample.sample_index)?;
            let available_mode_indices = native_mode_identities
                .iter()
                .map(|(raw, _)| {
                    u32::try_from(*raw).map_err(|_| RunError {
                        message: "native raw mode identity exceeds output selector range"
                            .to_string(),
                    })
                })
                .collect::<Result<BTreeSet<_>, _>>()?;
            self.mode_artifacts
                .borrow_mut()
                .extend(remap_single_k_mode_artifacts(
                    &executed.auxiliary_artifacts,
                    sample.sample_index,
                    &eigen_path_candidate_mode_indices(
                        &self.publication_outputs,
                        sample,
                        &available_mode_indices,
                    ),
                )?);
            let mut modes = Vec::with_capacity(modes_array.len());
            for (mode_json, (raw_mode_index, frequency_real_hz)) in
                modes_array.iter().zip(native_mode_identities)
            {
                let solver_device = if self.engine == FemEngine::NativeGpu {
                    "gpu"
                } else {
                    "cpu"
                };
                let component_participation = eigen_path_component_participation_from_json(
                    mode_json.get("component_participation"),
                    solver_device,
                )?;
                modes.push(SingleKModeResult {
                    raw_mode_index,
                    branch_id: None,
                    frequency_real_hz,
                    frequency_imag_hz: mode_json["frequency_imag_hz"].as_f64().unwrap_or(0.0),
                    angular_frequency_rad_per_s: mode_json["angular_frequency_rad_per_s"]
                        .as_f64()
                        .unwrap_or(0.0),
                    eigenvalue_real: mode_json["eigenvalue_real"].as_f64().unwrap_or(0.0),
                    eigenvalue_imag: mode_json["eigenvalue_imag"].as_f64().unwrap_or(0.0),
                    norm: mode_json["norm"].as_f64().unwrap_or(0.0),
                    mass_norm: mode_json["mass_norm"].as_f64(),
                    max_amplitude: mode_json["max_amplitude"].as_f64().unwrap_or(0.0),
                    residual_relative_l2: mode_json["residual_relative_l2"].as_f64(),
                    residual_norm: mode_json["residual_norm"].as_f64(),
                    residual_linf: mode_json["residual_linf"].as_f64(),
                    tangent_leakage_mean_abs: mode_json["tangent_leakage_mean_abs"].as_f64(),
                    tangent_leakage_max_abs: mode_json["tangent_leakage_max_abs"].as_f64(),
                    tangent_leakage_weighted_relative_l2: mode_json
                        ["tangent_leakage_weighted_relative_l2"]
                        .as_f64(),
                    dominant_polarization: mode_json["dominant_polarization"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    reduced_vector: eigen_path_mode_tracking_vector(
                        &executed.auxiliary_artifacts,
                        raw_mode_index,
                        Some(tracking_active_nodes),
                        &tracking_topology.coords,
                        sample.k_vector,
                        matches!(
                            point_plan.spin_wave_bc.kind(),
                            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
                        ),
                        tracking_metric.mesh_identity(),
                    )?,
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: None,
                    consistent_p1_metric: Some(tracking_metric.clone()),
                    component_participation,
                });
            }

            let mut seam_records = Vec::new();
            if matches!(
                point_plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Periodic
                    | fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            ) {
                for mode in &modes {
                    if let Some(vector) = mode.reduced_vector.as_deref() {
                        if let Some((checked_nodes, relative)) = tracking_metric
                            .periodic_seam_relative(
                                vector,
                                &tracking_topology.coords,
                                sample.k_vector,
                                &tracking_reduction.node_map,
                                &tracking_reduction.active_nodes,
                                &tracking_reduction.node_phases,
                            )
                            .map_err(|message| RunError { message })?
                        {
                            seam_records.push(serde_json::json!({
                            "definition_id": "magnetic_cartesian_periodic_seam_max_relative.v1",
                            "sample_index": sample.sample_index, "raw_mode_index": mode.raw_mode_index,
                            "frequency_hz": mode.frequency_real_hz, "k_vector": sample.k_vector,
                            "source_mesh_topology_sha256": tracking_metric.mesh_identity(),
                            "checked_slave_node_count": checked_nodes, "max_relative_mismatch": relative,
                            "scope": "magnetic_cartesian_field_only", "execution_lane": "postprocess_cpu",
                        }));
                        }
                    }
                }
            }
            let mut solver_diagnostics = spectrum.get("solver_diagnostics").cloned();
            // Preserve the original per-mode certificate before tracking
            // collapses the single-k result into common modal quantities.
            if let Some(diagnostics) = solver_diagnostics
                .as_mut()
                .and_then(serde_json::Value::as_object_mut)
            {
                let records = modes_array
                    .iter()
                    .filter_map(|native_mode| {
                        let blocks = native_mode.get("block_residuals")?;
                        Some(serde_json::json!({
                            "sample_index": sample.sample_index,
                            "raw_mode_index": native_mode["index"],
                            "frequency_hz": native_mode["frequency_real_hz"],
                            "block_residuals": blocks,
                        }))
                    })
                    .collect::<Vec<_>>();
                diagnostics.insert(
                    "mode_periodic_seam_measurements".into(),
                    serde_json::Value::Array(seam_records),
                );
                diagnostics.insert(
                    "tracking_mass_metric".into(),
                    serde_json::json!({
                        "definition_id": "consistent_p1_tet4_cartesian_nodal_envelope.v1",
                        "source_mesh_topology_sha256": tracking_metric.mesh_identity(),
                        "physical_magnetic_node_count": tracking_active_nodes.len(),
                        "projection_scope": "nodal_P1_envelope",
                        "execution_lane": "postprocess_cpu",
                        "qualification": "runtime_unqualified"
                    }),
                );
                diagnostics.insert(
                    "native_mode_block_residuals".into(),
                    serde_json::Value::Array(records),
                );
            }

            Ok(SingleKSolveResult {
                sample: sample.clone(),
                modes,
                relaxation_steps,
                solver_model: eigen_path_single_k_solver_model(
                    &point_plan,
                    &executed.auxiliary_artifacts,
                ),
                solver_notes: vec![solver_kind],
                solver_diagnostics,
            })
        }
    }

    let tracking_outputs = eigen_path_tracking_outputs(outputs, plan.count);
    let mode_fields_requested = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenMode { .. }));
    let wants_dispersion = eigen_path_wants_dispersion(outputs);
    if bias_field_sweep_requested(plan) {
        let samples = super::eigen_sweep::validate_bias_field_samples(plan)?;
        let expanded_samples = crate::eigen::expand_k_sampling(plan.k_sampling.as_ref())
            .map_err(|message| RunError { message })?;
        if expanded_samples.len() != samples.len() {
            return Err(RunError {
                message: format!(
                    "FEM bias-field path has {} k samples but {} bias_field_samples entries",
                    expanded_samples.len(),
                    samples.len()
                ),
            });
        }
    }
    // Resolve and preflight before the first native solve. Each invocation
    // owns a fresh raw namespace, so retrying an output directory preserves
    // old checkpoint bytes without colliding with sample zero.
    let absolute_process_root = process_root
        .map(super::single_k_checkpoint::prepare_checkpoint_process_root)
        .transpose()
        .map_err(|error| RunError {
            message: format!("prepare FEM checkpoint output root: {error}"),
        })?;
    let checkpoint_root = absolute_process_root
        .as_deref()
        .map(super::single_k_checkpoint::create_raw_checkpoint_attempt)
        .transpose()
        .map_err(|error| RunError {
            message: format!("prepare FEM raw checkpoint attempt: {error}"),
        })?;
    let (precomputed, parallel_report) =
        if parallel_policy.mode == ParallelExecutionModeIR::Adaptive {
            match prepare_process_pool_samples(
                execution,
                plan,
                &tracking_outputs,
                outputs,
                parallel_policy,
                absolute_process_root.as_deref(),
                checkpoint_root.as_deref(),
                source_relax_handoff,
                producer_identity,
                &mut progress,
            )? {
                ProcessPoolPreparation::Ready {
                    precomputed,
                    report,
                } => (precomputed, Some(report)),
                ProcessPoolPreparation::Interrupted(interrupted) => {
                    let accepted_magnetization = source_relax_handoff
                        .map(|handoff| handoff.equilibrium_magnetization.clone())
                        .unwrap_or_else(|| plan.equilibrium_magnetization.clone());
                    return Ok(interrupted_eigen_path_run(
                        plan,
                        interrupted,
                        accepted_magnetization,
                    ));
                }
            }
        } else {
            (HashMap::new(), None)
        };
    let adapter = KSolverAdapter {
        progress: std::sync::Mutex::new(progress),
        execution,
        engine,
        mode_artifacts: RefCell::new(Vec::new()),
        checkpoint_root,
        publication_outputs: outputs.to_vec(),
        tracking_metric: RefCell::new(None),
        source_relax_handoff: source_relax_handoff.cloned(),
        producer_identity: producer_identity.cloned(),
        interrupted_single_k: RefCell::new(None),
        previous_accepted_magnetization: RefCell::new(None),
        periodic_airbox_k0_metrics: RefCell::new(None),
        precomputed: RefCell::new(precomputed),
        parallel_report,
    };
    let mut path_result = match run_path_or_single(
        &adapter,
        plan,
        &tracking_outputs,
        None, // we collect artifacts manually below
        None,
        plan.mode_tracking.as_ref(),
    ) {
        Ok(result) => result,
        Err(error) => {
            if let Some(interrupted) = adapter.interrupted_single_k.borrow_mut().take() {
                let accepted_magnetization = adapter
                    .previous_accepted_magnetization
                    .borrow()
                    .clone()
                    .or_else(|| {
                        source_relax_handoff
                            .map(|handoff| handoff.equilibrium_magnetization.clone())
                    })
                    .unwrap_or_else(|| plan.equilibrium_magnetization.clone());
                return Ok(interrupted_eigen_path_run(
                    plan,
                    interrupted,
                    accepted_magnetization,
                ));
            }
            return Err(error);
        }
    };
    // Guard before any spectrum or mode JSON can serialize nonfinite gamma to null.
    eigen_path_publication_gamma0(plan, &path_result)?;
    let last_accepted_magnetization = adapter.previous_accepted_magnetization.into_inner();
    let final_magnetization = if bias_field_sweep_requested(plan) {
        last_accepted_magnetization.ok_or_else(|| RunError {
            message: "FEM bias-field path completed without an accepted equilibrium".to_string(),
        })?
    } else {
        last_accepted_magnetization.unwrap_or_else(|| {
            source_relax_handoff
                .map(|handoff| handoff.equilibrium_magnetization.clone())
                .unwrap_or_else(|| plan.equilibrium_magnetization.clone())
        })
    };
    path_result.k0_kittel_periodic_airbox_demag = adapter.periodic_airbox_k0_metrics.into_inner();
    if path_result.k0_kittel_periodic_airbox_demag.is_some() && engine == FemEngine::CpuNative {
        path_result.solver_model = crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    }
    if periodic_airbox_k0_runtime_supported(plan) && engine == FemEngine::NativeGpu {
        path_result.solver_model = crate::eigen::EigenSolverModel::ProductionGpuModalDeviceKrylov;
    }
    let selection = select_eigen_outputs(&path_result, outputs).map_err(|error| RunError {
        message: format!("invalid eigen output selection: {error}"),
    })?;
    let has_public_spectrum_output = outputs.iter().any(|output| {
        matches!(
            output,
            OutputIR::EigenSpectrum { .. }
                | OutputIR::EigenMode { .. }
                | OutputIR::DispersionCurve { .. }
        )
    });
    let diagnostics_only = selection.diagnostics_request().is_some() && !has_public_spectrum_output;
    let published_mode_ids: BTreeSet<SampleModeId> = selection
        .spectrum_mode_ids()
        .union(selection.field_mode_ids())
        .copied()
        .collect();
    let branch_table_requested = selection.branch_table_requested();
    let parallel_report = adapter.parallel_report;
    let mut mode_artifacts = adapter.mode_artifacts.into_inner();
    deduplicate_auxiliary_artifacts_by_path(&mut mode_artifacts)?;
    // The synthetic K0 validation oracle does not synthesize topology-bound mode
    // fields unless the caller explicitly requested EigenMode output. In
    // particular, an EigenSpectrum-only K0 field sweep must not trigger a
    // hidden mode-bundle write and then fail on a mesh identity that was never
    // requested. DE/BV validation always reaches this point through the native
    // FEM solve and therefore never needs a synthetic mode fallback.
    if mode_artifacts.is_empty()
        && mode_fields_requested
        && k0_kittel_synthetic_demag_factor_enabled(plan)
        && !bias_field_sweep_requested(plan)
    {
        mode_artifacts = eigen_path_mode_artifacts_from_result(&path_result)?;
    }

    let sample_descriptors = path_result
        .samples
        .iter()
        .map(|sample| sample.sample.clone())
        .collect::<Vec<_>>();
    let actual_mode_ids = path_result
        .samples
        .iter()
        .flat_map(|sample| {
            sample.modes.iter().map(|mode| {
                SampleModeId::new(sample.sample.sample_index, mode.raw_mode_index)
            })
        })
        .collect::<BTreeSet<_>>();
    materialize_selected_path_physical_potential_artifacts(
        plan,
        &sample_descriptors,
        &actual_mode_ids,
        selection.field_mode_ids(),
        &mut mode_artifacts,
    )?;

    retain_selected_eigen_path_mode_artifacts(&mut mode_artifacts, selection.field_mode_ids());
    validate_eigen_path_selected_mode_artifacts(&mode_artifacts, selection.field_mode_ids())?;
    bind_eigen_path_tracked_mode_metadata(&mut mode_artifacts, &path_result)?;

    // Build the ExecutedRun with both V2 and legacy-compatible artifacts
    let mut auxiliary_artifacts = Vec::new();

    // V2 path artifact (eigen/path.json)
    let v2_samples: Vec<serde_json::Value> = path_result
        .samples
        .iter()
        .map(|s| {
            serde_json::json!({
                "sample_id": eigen_path_sample_id(plan, &s.sample),
                "sample_index": s.sample.sample_index,
                "label": s.sample.label,
                "k_vector": s.sample.k_vector,
                "path_s": s.sample.path_s,
                "segment_index": s.sample.segment_index,
                "t_in_segment": s.sample.t_in_segment,
                "modes": s
                    .modes
                    .iter()
                    .filter(|m| published_mode_ids.contains(&SampleModeId::new(s.sample.sample_index, m.raw_mode_index)))
                    .map(|m| {
                        eigen_path_mode_publication_json(eigen_path_mode_json(
                            plan,
                            &s.sample,
                            m,
                            path_result.solver_model,
                            s.solver_diagnostics.as_ref(),
                        ), s.sample.sample_index, m.raw_mode_index, selection.field_mode_ids())
                    })
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    let path_json = serde_json::json!({
        "schema_version": "2",
        "solver_model": path_result.solver_model.as_str(),
        "sample_count": v2_samples.len(),
        "samples": v2_samples.clone(),
    });
    let phase_convention = serde_json::to_value(plan.spin_wave_bc.phase_convention())
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "exp_minus_i_k_dot_delta_r".to_string());
    let overlap_values = eigen_path_overlap_values(&path_result, &selection);
    let min_overlap = overlap_values
        .iter()
        .copied()
        .reduce(|lhs, rhs| lhs.min(rhs));
    let median_overlap = median_f64(&overlap_values);
    let (tracking_score_source, modal_overlap_available) =
        eigen_path_tracking_score_summary(&path_result);
    let modal_overlap_unavailable_reason = if modal_overlap_available {
        serde_json::Value::Null
    } else if path_result
        .branches
        .iter()
        .flat_map(|branch| &branch.points)
        .any(|point| {
            point.tracking_edge.as_ref().is_some_and(|edge| {
                matches!(
                    edge.transition,
                    crate::eigen::types::TrackingTransition::NewBranch
                )
            })
        })
    {
        serde_json::json!("tracking_restart_without_predecessor")
    } else if tracking_score_source == "frequency_score_fallback" {
        serde_json::json!("mode_vectors_unavailable")
    } else {
        serde_json::json!("tracking_metric_or_edge_evidence_unavailable")
    };
    let gap_count = path_result
        .branches
        .iter()
        .map(|branch| v2_samples.len().saturating_sub(branch.points.len()))
        .sum::<usize>();
    let public_mode_count = eigen_path_public_mode_count(&path_result, &published_mode_ids);
    let dispersion_diagnostics_summary = serde_json::json!({
        "schema_version": "eigen_diagnostics.v2",
        "dispersion": {
            "sample_count": path_result.samples.len(),
            "mode_count_requested": plan.count,
            "branch_count": path_result.branches.len(),
            "min_overlap": min_overlap,
            "median_overlap": median_overlap,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": modal_overlap_unavailable_reason,
            "gap_count": gap_count,
            "ambiguous_assignment_count": Option::<u64>::None,
            "ambiguous_assignment_count_available": false,
            "ambiguous_assignment_count_unavailable_reason":
                "assignment_ambiguity_metric_not_computed",
        },
    });
    let diagnostics_v2 = selection.diagnostics_request().map(|request| {
        let samples = path_result
            .samples
            .iter()
            .map(|sample| {
                let modes = sample
                    .modes
                    .iter()
                    .filter(|mode| {
                        request.any_enabled()
                            && selection
                                .diagnostic_mode_ids()
                                .contains(&SampleModeId::new(
                                    sample.sample.sample_index,
                                    mode.raw_mode_index,
                                ))
                    })
                    .map(|mode| {
                        EigenDiagnosticModeRecord::from_mode(sample.sample.sample_index, mode)
                    })
                    .collect();
                EigenDiagnosticSampleRecord {
                    sample_index: sample.sample.sample_index,
                    computed_mode_count: sample.modes.len(),
                    modes,
                    mass_orthogonality: canonical_mass_orthogonality_rows(
                        sample.solver_diagnostics.as_ref(),
                        sample.sample.sample_index,
                    ),
                }
            })
            .collect::<Vec<_>>();
        let transport = eigen_path_diagnostics_transport_metadata(&path_result, Some(plan));
        build_eigen_diagnostics_v2(
            path_result.solver_model.as_str(),
            "path_orchestrator",
            &samples,
            &path_result.branches,
            request,
            Some(plan.count as usize),
            Some(&transport),
        )
    });
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_id": path_result.solver_model.as_str(),
        "phase_convention": phase_convention,
        "sample_count": v2_samples.len(),
        "mode_count": public_mode_count,
        "samples": v2_samples.clone(),
        "diagnostics_summary": dispersion_diagnostics_summary["dispersion"].clone(),
    });
    let spectrum_v3_samples = path_result
        .samples
        .iter()
        .map(|sample| {
            serde_json::json!({
                "sample_id": eigen_path_sample_id(plan, &sample.sample),
                "sample_index": sample.sample.sample_index,
                "label": sample.sample.label,
                "k_vector": sample.sample.k_vector,
                "path_s": sample.sample.path_s,
                "segment_index": sample.sample.segment_index,
                "t_in_segment": sample.sample.t_in_segment,
                "modes": sample
                    .modes
                    .iter()
                    .filter(|mode| published_mode_ids.contains(&SampleModeId::new(sample.sample.sample_index, mode.raw_mode_index)))
                    .map(|mode| {
                        eigen_path_mode_publication_json(eigen_path_mode_v3_json(
                            plan,
                            &sample.sample,
                            mode,
                            path_result.solver_model,
                            sample.solver_diagnostics.as_ref(),
                        ), sample.sample.sample_index, mode.raw_mode_index, selection.field_mode_ids())
                    })
                    .collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let spectrum_v3 = serde_json::json!({
        "schema_version": "eigen_spectrum.v3",
        "solver_id": path_result.solver_model.as_str(),
        "phase_convention": phase_convention,
        "sample_count": spectrum_v3_samples.len(),
        "mode_count": public_mode_count,
        "samples": spectrum_v3_samples,
        "diagnostics_summary": dispersion_diagnostics_summary["dispersion"].clone(),
    });
    if !diagnostics_only {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/spectrum.v2.json".to_string(),
            bytes: serde_json::to_vec_pretty(&spectrum_v2).unwrap_or_default(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/spectrum.v3.json".to_string(),
            bytes: serde_json::to_vec_pretty(&spectrum_v3).unwrap_or_default(),
        });
    }
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/path.json".to_string(),
        bytes: serde_json::to_vec_pretty(&path_json).unwrap_or_default(),
    });

    // V2 branches artifact (eigen/branches.json)
    let v2_branches: Vec<serde_json::Value> = path_result
        .branches
        .iter()
        .filter_map(|b| {
            let points = b
                .points
                .iter()
                .enumerate()
                .filter(|(_, p)| published_mode_ids.contains(&SampleModeId::new(p.sample_index, p.raw_mode_index)))
                .map(|(point_index, p)| {
                    let mode = eigen_path_mode_for_branch_point(&path_result, p);
                    let point_modal_overlap_available =
                        eigen_path_branch_point_modal_overlap_available(&path_result, b, point_index);
                    serde_json::json!({
                        "sample_id": eigen_path_sample_id_for_index(plan, p.sample_index),
                        "mode_id": eigen_path_mode_id(p.sample_index, p.raw_mode_index),
                        "sample_index": p.sample_index,
                        "raw_mode_index": p.raw_mode_index,
                        "frequency_hz": p.frequency_real_hz,
                        "frequency_real_hz": p.frequency_real_hz,
                        "frequency_imag_hz": p.frequency_imag_hz,
                        "angular_frequency_rad_per_s": mode
                            .map(|mode| mode.angular_frequency_rad_per_s)
                            .unwrap_or(p.frequency_real_hz * std::f64::consts::TAU),
                        "tracking_confidence": p.tracking_confidence,
                        "overlap_prev": p.overlap_prev,
                        "tracking_edge": p.tracking_edge,
                        "tracking_score_source": eigen_path_branch_point_tracking_score_source(
                            &path_result,
                            b,
                            point_index,
                        ),
                        "modal_overlap_available": point_modal_overlap_available,
                        "residual_norm": mode.and_then(|mode| mode.residual_norm),
                        "residual_linf": mode.and_then(|mode| mode.residual_linf),
                        "tangent_leakage_mean_abs": mode.and_then(|mode| mode.tangent_leakage_mean_abs),
                        "tangent_leakage_max_abs": mode.and_then(|mode| mode.tangent_leakage_max_abs),
                        "tangent_leakage_weighted_relative_l2": mode.and_then(|mode| mode.tangent_leakage_weighted_relative_l2),
                        "mode_field_id": eigen_path_mode_field_id(
                            p.sample_index,
                            p.raw_mode_index,
                        ),
                        "mode_field_available": selection.contains_field_mode(p.sample_index, p.raw_mode_index),
                    })
                })
                .collect::<Vec<_>>();
            if points.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "branch_id": b.branch_id,
                "label": b.label,
                "points": points,
            }))
        })
        .collect();
    let recorded_policy = crate::eigen::tracking::recorded_tracking_policy(&path_result);
    let tracking_policy_availability = if recorded_policy.is_some() {
        "complete"
    } else {
        "missing_or_mixed"
    };
    let branches_v2 = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "tracking_policy_availability": tracking_policy_availability,
        "tracking_method": recorded_policy.map(|policy| policy.method),
        "tracking_score_source": tracking_score_source,
        "modal_overlap_available": modal_overlap_available,
        "overlap_floor": recorded_policy.map(|policy| policy.overlap_floor),
        "frequency_window_hz": recorded_policy.and_then(|policy| policy.frequency_window_hz),
        "branches": v2_branches.clone(),
        "diagnostics": {
            "min_overlap": min_overlap,
            "median_overlap": median_overlap,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": modal_overlap_unavailable_reason,
            "gap_count": gap_count,
            "ambiguous_assignment_count": Option::<u64>::None,
            "ambiguous_assignment_count_available": false,
            "ambiguous_assignment_count_unavailable_reason":
                "assignment_ambiguity_metric_not_computed",
        },
    });
    if branch_table_requested {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/branches.v2.json".to_string(),
            bytes: serde_json::to_vec_pretty(&branches_v2).unwrap_or_default(),
        });
    }
    if let Some(diagnostics) = diagnostics_v2.as_ref() {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/diagnostics.v2.json".to_string(),
            bytes: serde_json::to_vec_pretty(diagnostics).unwrap_or_default(),
        });
    }
    if branch_table_requested {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/branches.json".to_string(),
            bytes: serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": "2",
                "tracking_policy_availability": tracking_policy_availability,
                "solver_model": path_result.solver_model.as_str(),
                "tracking_method": recorded_policy.map(|policy| policy.method),
                "overlap_floor": recorded_policy.map(|policy| policy.overlap_floor),
                "frequency_window_hz": recorded_policy.and_then(|policy| policy.frequency_window_hz),
                "branches": v2_branches,
            }))
            .unwrap_or_default(),
        });
    }

    let solver_diagnostics =
        eigen_path_solver_diagnostics(engine, plan, &path_result, &published_mode_ids);
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/diagnostics/solver.v1.json".to_string(),
        bytes: serde_json::to_vec_pretty(&solver_diagnostics).unwrap_or_default(),
    });

    // Legacy-compatible spectrum.json from the first sample
    if !diagnostics_only {
        if let Some(first_sample) = path_result.samples.first() {
        let modes_summary: Vec<serde_json::Value> = first_sample
            .modes
            .iter()
            .filter(|m| {
                published_mode_ids.contains(&SampleModeId::new(
                    first_sample.sample.sample_index,
                    m.raw_mode_index,
                ))
            })
            .map(|m| {
                eigen_path_mode_publication_json(
                    eigen_path_mode_v3_json(
                        plan,
                        &first_sample.sample,
                        m,
                        path_result.solver_model,
                        first_sample.solver_diagnostics.as_ref(),
                    ),
                    first_sample.sample.sample_index,
                    m.raw_mode_index,
                    selection.field_mode_ids(),
                )
            })
            .collect();
        let production_path = matches!(
            path_result.solver_model,
            crate::eigen::EigenSolverModel::ProductionCpuShiftInvert
                | crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin
                | crate::eigen::EigenSolverModel::ProductionGpuModalDeviceKrylov
        );

        let legacy_spectrum = serde_json::json!({
            "study_kind": "eigenmodes",
            "solver_backend": if production_path { "native_fem_modal_eigen" } else { "cpu_baseline_fem_eigen" },
            "solver_kind": path_result.solver_model.as_str(),
            "mesh_name": plan.mesh_name,
            "mode_count": modes_summary.len(),
            "normalization": format!("{:?}", plan.normalization).to_lowercase(),
            "damping_policy": format!("{:?}", plan.damping_policy).to_lowercase(),
            "spin_wave_bc": format!("{:?}", plan.spin_wave_bc.kind()).to_lowercase(),
            "equilibrium_source": eigen_path_equilibrium_source_json(plan, first_sample.relaxation_steps),
            "included_terms": {
                "exchange": plan.enable_exchange,
                "demag": plan.operator.include_demag,
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
            "k_sampling": plan.k_sampling,
            "relaxation_steps": first_sample.relaxation_steps,
            "modes": modes_summary,
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/spectrum.json".to_string(),
            bytes: serde_json::to_vec_pretty(&legacy_spectrum).unwrap_or_default(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: serde_json::to_vec_pretty(&legacy_spectrum).unwrap_or_default(),
        });
        if wants_dispersion {
            // Legacy dispersion CSV with all samples × modes
            let mut csv_lines = vec![
                "mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s,sample_id,mode_id"
                    .to_string(),
            ];
            for sample_result in &path_result.samples {
                let k = sample_result.sample.k_vector;
                for mode in &sample_result.modes {
                    if !published_mode_ids.contains(&SampleModeId::new(
                        sample_result.sample.sample_index,
                        mode.raw_mode_index,
                    )) {
                        continue;
                    }
                    csv_lines.push(format!(
                        "{},{},{},{},{},{},{},{}",
                        mode.raw_mode_index,
                        k[0],
                        k[1],
                        k[2],
                        mode.frequency_real_hz,
                        mode.angular_frequency_rad_per_s,
                        eigen_path_sample_id(plan, &sample_result.sample),
                        eigen_path_mode_id(sample_result.sample.sample_index, mode.raw_mode_index,),
                    ));
                }
            }
            if branch_table_requested {
                auxiliary_artifacts.push(AuxiliaryArtifact {
                    relative_path: "eigen/dispersion/branch_table.csv".to_string(),
                    bytes: csv_lines.join("\n").into_bytes(),
                });
            }

            let mut dispersion_v2_lines = vec![
            "sample_index,sample_id,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,mode_id,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_available,mode_field_id"
                .to_string(),
        ];
            for sample_result in &path_result.samples {
                let k = sample_result.sample.k_vector;
                let label = sample_result.sample.label.clone().unwrap_or_default();
                for mode in &sample_result.modes {
                    if !published_mode_ids.contains(&SampleModeId::new(
                        sample_result.sample.sample_index,
                        mode.raw_mode_index,
                    )) {
                        continue;
                    }
                    let branch_point = eigen_path_branch_point_for_mode(
                        &path_result,
                        sample_result.sample.sample_index,
                        mode.raw_mode_index,
                    );
                    let overlap_score = branch_point
                        .as_ref()
                        .and_then(|(_, _, point)| point.overlap_prev)
                        .map(|value| value.to_string())
                        .unwrap_or_default();
                    let tracking_score_source = branch_point
                        .as_ref()
                        .map(|(branch, point_index, _)| {
                            eigen_path_branch_point_tracking_score_source(
                                &path_result,
                                branch,
                                *point_index,
                            )
                        })
                        .unwrap_or_default();
                    let line_width_hz =
                        eigen_path_line_width_hz(mode.frequency_imag_hz).unwrap_or_default();
                    let mode_field_available = selection.contains_field_mode(
                        sample_result.sample.sample_index,
                        mode.raw_mode_index,
                    );
                    let validation_columns =
                        eigen_path_de_bv_analytic_csv_columns(plan, &sample_result.sample, mode);
                    dispersion_v2_lines.push(format!(
                        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                        sample_result.sample.sample_index,
                        eigen_path_sample_id(plan, &sample_result.sample),
                        sample_result.sample.path_s,
                        k[0],
                        k[1],
                        k[2],
                        label,
                        mode.raw_mode_index,
                        eigen_path_mode_id(sample_result.sample.sample_index, mode.raw_mode_index,),
                        mode.branch_id
                            .map(|branch_id| branch_id.to_string())
                            .unwrap_or_default(),
                        mode.frequency_real_hz,
                        mode.angular_frequency_rad_per_s,
                        validation_columns.analytic_frequency_hz,
                        validation_columns.relative_error,
                        validation_columns.geometry,
                        line_width_hz,
                        mode.residual_norm
                            .map(|value| format!("{value:.16e}"))
                            .unwrap_or_default(),
                        overlap_score,
                        tracking_score_source,
                        mode_field_available,
                        eigen_path_mode_field_id(
                            sample_result.sample.sample_index,
                            mode.raw_mode_index,
                        ),
                    ));
                }
            }
            auxiliary_artifacts.push(AuxiliaryArtifact {
                relative_path: "eigen/dispersion.csv".to_string(),
                bytes: dispersion_v2_lines.join("\n").into_bytes(),
            });

            // Legacy dispersion path metadata
            auxiliary_artifacts.push(AuxiliaryArtifact {
                relative_path: "eigen/dispersion/path.json".to_string(),
                bytes: serde_json::to_vec_pretty(&serde_json::json!({
                    "sampling": plan.k_sampling,
                }))
                .unwrap_or_default(),
            });
        }
    }
    }
    append_eigen_path_k0_kittel_validation_artifacts(&mut auxiliary_artifacts, &path_result)?;
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "frequency_domain/manifest.v1.json".to_string(),
        bytes: serde_json::to_vec_pretty(&build_eigen_path_frequency_domain_manifest(
            engine,
            &path_result,
            &mode_artifacts,
            plan,
            outputs,
        ))
        .map_err(|error| RunError {
            message: format!("failed to serialize k-path frequency-domain manifest: {error}"),
        })?,
    });
    auxiliary_artifacts.extend(mode_artifacts);
    if let Some(report) = parallel_report {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/parallel_execution.v1.json".to_string(),
            bytes: serde_json::to_vec_pretty(&report).map_err(|error| RunError {
                message: format!("failed to serialize adaptive process-pool report: {error}"),
            })?,
        });
    }

    Ok(ExecutedRun {
        result: crate::types::RunResult {
            status: crate::types::RunStatus::Completed,
            steps: vec![],
            final_magnetization,
            completion: Some(crate::relaxation::resolve_stage_completion(
                crate::types::RunStatus::Completed,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: crate::ExecutionProvenance {
            execution_engine: format!("multi_k_orchestrator/{}", path_result.solver_model.as_str()),
            precision: "double".to_string(),
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod checkpoint_admission_tests {
    use super::*;
    use crate::eigen::{run_path_or_single, EigenSolverModel, SingleKSolver};
    use crate::types::{ExecutionProvenance, RunResult};
    use std::cell::{Cell, RefCell};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    const RAW_BYTES: &[u8] = b"native raw single-k bytes\0keep exact";

    static NEXT_TEMP_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = NEXT_TEMP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "fullmag-eigen-path-admission-{}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test-owned temporary directory");
            Self(fs::canonicalize(&path).expect("canonicalize test directory"))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn three_sample_plan() -> FemEigenPlanIR {
        let mut plan = crate::fem::eigen_tests::minimal_native_modal_plan();
        plan.k_sampling = Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR::gamma(),
                fullmag_ir::KPointIR {
                    label: Some("X".into()),
                    k_vector: [1.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("M".into()),
                    k_vector: [1.0, 1.0, 0.0],
                },
            ],
            samples_per_segment: vec![1, 1],
            closed: false,
        });
        plan
    }

    fn test_resolution() -> fullmag_ir::FemEigenExecutionResolutionIR {
        fullmag_ir::FemEigenExecutionResolutionIR {
            requested_device: fullmag_ir::ExecutionDevice::Cpu,
            resolved_device: fullmag_ir::ExecutionDevice::Cpu,
            requested_precision: fullmag_ir::ExecutionPrecision::Double,
            resolved_precision: fullmag_ir::ExecutionPrecision::Double,
            requested_engine: fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            resolved_engine: fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            fallback_used: false,
            fallback_reason: None,
            selection_reason: "test.single_k_checkpoint_admission".into(),
        }
    }

    struct CheckpointAdmissionSolver {
        checkpoint_root: PathBuf,
        interrupt_at: Option<(usize, RunStatus)>,
        calls: Cell<usize>,
        parse_count: Cell<usize>,
        promotion_count: Cell<usize>,
        publication_count: Cell<usize>,
        interrupted: RefCell<Option<InterruptedSingleK>>,
        last_accepted_magnetization: RefCell<Option<Vec<[f64; 3]>>>,
        resolution: fullmag_ir::FemEigenExecutionResolutionIR,
    }

    impl CheckpointAdmissionSolver {
        fn new(checkpoint_root: &Path, interrupt_at: Option<(usize, RunStatus)>) -> Self {
            Self {
                checkpoint_root: checkpoint_root.to_path_buf(),
                interrupt_at,
                calls: Cell::new(0),
                parse_count: Cell::new(0),
                promotion_count: Cell::new(0),
                publication_count: Cell::new(0),
                interrupted: RefCell::new(None),
                last_accepted_magnetization: RefCell::new(None),
                resolution: test_resolution(),
            }
        }

        fn raw_checkpoint(&self, sample_index: usize) -> PathBuf {
            self.checkpoint_root
                .join("eigen")
                .join("sample-checkpoints")
                .join(format!("sample-{sample_index:04}"))
                .join("artifacts")
                .join("eigen")
                .join("spectrum.json")
        }
    }

    impl SingleKSolver for CheckpointAdmissionSolver {
        fn solve_single_k(
            &self,
            plan: &FemEigenPlanIR,
            _outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveResult, RunError> {
            self.calls.set(self.calls.get() + 1);
            let status = self
                .interrupt_at
                .filter(|(sample_index, _)| *sample_index == sample.sample_index)
                .map(|(_, status)| status)
                .unwrap_or(RunStatus::Completed);
            let point_plan = eigen_path_single_k_point_plan(plan, sample, false, None)?;
            let returned_magnetization = if status == RunStatus::Completed {
                vec![[0.0, 1.0, 0.0]; plan.mesh.nodes.len()]
            } else {
                vec![[9.0, 8.0, 7.0]; plan.mesh.nodes.len()]
            };
            let run = ExecutedRun {
                result: RunResult {
                    status,
                    steps: Vec::new(),
                    final_magnetization: returned_magnetization,
                    completion: Some(crate::relaxation::resolve_stage_completion(
                        status,
                        None,
                        crate::relaxation::RelaxationCompletionMetrics::default(),
                    )),
                },
                initial_magnetization: plan.equilibrium_magnetization.clone(),
                field_snapshots: Vec::new(),
                field_snapshot_count: 0,
                auxiliary_artifacts: vec![AuxiliaryArtifact {
                    relative_path: "eigen/spectrum.json".into(),
                    bytes: RAW_BYTES.to_vec(),
                }],
                provenance: ExecutionProvenance {
                    execution_engine: "fem_eigen_cpu_baseline".into(),
                    precision: "double".into(),
                    fem_eigen_execution_resolution: Some(self.resolution.clone()),
                    ..Default::default()
                },
            };

            match checkpoint_and_admit_single_k(
                Some(&self.checkpoint_root),
                sample,
                &point_plan,
                &run,
            )? {
                SingleKCheckpointAdmission::Completed => {
                    self.parse_count.set(self.parse_count.get() + 1);
                    self.promotion_count.set(self.promotion_count.get() + 1);
                    self.publication_count.set(self.publication_count.get() + 1);
                    *self.last_accepted_magnetization.borrow_mut() =
                        Some(run.result.final_magnetization.clone());
                    Ok(SingleKSolveResult {
                        sample: sample.clone(),
                        modes: Vec::new(),
                        relaxation_steps: 0,
                        solver_model: EigenSolverModel::ReferenceScalarTangent,
                        solver_notes: Vec::new(),
                        solver_diagnostics: None,
                    })
                }
                SingleKCheckpointAdmission::Interrupted(interrupted) => {
                    *self.interrupted.borrow_mut() = Some(interrupted);
                    Err(RunError {
                        message: "test solver stopped after a typed terminal status".into(),
                    })
                }
            }
        }
    }

    fn expected_terminal_status_label(status: RunStatus) -> &'static str {
        match status {
            RunStatus::Cancelled => "cancelled",
            RunStatus::Paused => "paused",
            RunStatus::Completed | RunStatus::Failed => {
                panic!("expected an interrupted terminal status")
            }
        }
    }

    #[test]
    fn noncompleted_single_k_status_preserves_raw_bytes_and_stops_admission() {
        for status in [RunStatus::Cancelled, RunStatus::Paused, RunStatus::Failed] {
            let checkpoint_root = TestDirectory::new();
            let plan = three_sample_plan();
            let solver = CheckpointAdmissionSolver::new(checkpoint_root.path(), Some((1, status)));

            let error = run_path_or_single(&solver, &plan, &[], None, None, None)
                .expect_err("a noncompleted sample must stop the k path");

            assert_eq!(solver.calls.get(), 2, "the following k sample must not run");
            assert_eq!(solver.parse_count.get(), 1);
            assert_eq!(solver.promotion_count.get(), 1);
            assert_eq!(solver.publication_count.get(), 1);
            assert_eq!(
                fs::read(solver.raw_checkpoint(0)).expect("completed raw checkpoint"),
                RAW_BYTES
            );
            assert_eq!(
                fs::read(solver.raw_checkpoint(1)).expect("noncompleted raw checkpoint"),
                RAW_BYTES
            );
            assert!(!solver.raw_checkpoint(2).exists());

            match status {
                RunStatus::Cancelled | RunStatus::Paused => {
                    let interrupted = solver
                        .interrupted
                        .borrow_mut()
                        .take()
                        .expect("typed interruption is retained separately from RunError");
                    assert_eq!(interrupted.status, status);
                    let accepted = solver
                        .last_accepted_magnetization
                        .borrow()
                        .clone()
                        .expect("first sample was accepted");
                    let terminal = interrupted_eigen_path_run(&plan, interrupted, accepted.clone());
                    assert_eq!(terminal.result.status, status);
                    assert_eq!(
                        terminal.result.completion.as_ref().unwrap().status,
                        expected_terminal_status_label(status)
                    );
                    assert_eq!(
                        terminal.initial_magnetization,
                        plan.equilibrium_magnetization
                    );
                    assert_eq!(terminal.result.final_magnetization, accepted);
                    assert!(terminal.auxiliary_artifacts.is_empty());
                    assert_eq!(
                        terminal.provenance.execution_engine,
                        "fem_eigen_cpu_baseline"
                    );
                    assert_eq!(
                        terminal.provenance.fem_eigen_execution_resolution,
                        Some(solver.resolution.clone())
                    );
                }
                RunStatus::Failed => {
                    assert!(solver.interrupted.borrow().is_none());
                    assert!(error.message.contains("returned failed status"));
                }
                RunStatus::Completed => unreachable!("completed is not part of this test"),
            }
        }
    }

    #[test]
    fn completed_single_k_status_admits_and_publishes_every_path_sample() {
        let checkpoint_root = TestDirectory::new();
        let plan = three_sample_plan();
        let solver = CheckpointAdmissionSolver::new(checkpoint_root.path(), None);

        let result = run_path_or_single(&solver, &plan, &[], None, None, None)
            .expect("completed samples should aggregate normally");

        assert_eq!(result.samples.len(), 3);
        assert_eq!(solver.calls.get(), 3);
        assert_eq!(solver.parse_count.get(), 3);
        assert_eq!(solver.promotion_count.get(), 3);
        assert_eq!(solver.publication_count.get(), 3);
        assert!(solver.interrupted.borrow().is_none());
        for sample_index in 0..3 {
            assert_eq!(
                fs::read(solver.raw_checkpoint(sample_index)).expect("raw checkpoint"),
                RAW_BYTES
            );
        }
    }

    #[test]
    fn interrupted_status_keeps_available_raw_diagnostics_with_or_without_checkpoint_root() {
        const RAW_DIAGNOSTIC: &[u8] = b"partial residual and stop diagnostic bytes\0";

        for status in [RunStatus::Cancelled, RunStatus::Paused] {
            let plan = three_sample_plan();
            let sample = crate::eigen::expand_k_sampling(plan.k_sampling.as_ref())
                .expect("valid test path")
                .remove(0);
            let point_plan = eigen_path_single_k_point_plan(&plan, &sample, false, None)
                .expect("valid point plan");
            let run = ExecutedRun {
                result: RunResult {
                    status,
                    steps: Vec::new(),
                    final_magnetization: vec![[9.0, 8.0, 7.0]; plan.mesh.nodes.len()],
                    completion: Some(crate::relaxation::resolve_stage_completion(
                        status,
                        None,
                        crate::relaxation::RelaxationCompletionMetrics::default(),
                    )),
                },
                initial_magnetization: plan.equilibrium_magnetization.clone(),
                field_snapshots: Vec::new(),
                field_snapshot_count: 0,
                auxiliary_artifacts: vec![AuxiliaryArtifact {
                    relative_path: "eigen/diagnostics/solver.v1.json".into(),
                    bytes: RAW_DIAGNOSTIC.to_vec(),
                }],
                provenance: ExecutionProvenance {
                    execution_engine: "fem_eigen_cpu_baseline".into(),
                    precision: "double".into(),
                    fem_eigen_execution_resolution: Some(test_resolution()),
                    ..Default::default()
                },
            };

            let no_root = match checkpoint_and_admit_single_k(None, &sample, &point_plan, &run)
                .expect("in-memory diagnostic preservation")
            {
                SingleKCheckpointAdmission::Interrupted(interrupted) => interrupted,
                SingleKCheckpointAdmission::Completed => {
                    panic!("an interrupted status must not be admitted")
                }
            };
            assert_eq!(no_root.status, status);
            let no_root_run =
                interrupted_eigen_path_run(&plan, no_root, plan.equilibrium_magnetization.clone());
            let raw_relative_path =
                "eigen/diagnostics/raw_single_k/sample_0000/artifacts/eigen/diagnostics/solver.v1.json";
            assert_eq!(
                no_root_run
                    .auxiliary_artifacts
                    .iter()
                    .find(|artifact| artifact.relative_path == raw_relative_path)
                    .expect("namespaced raw diagnostics")
                    .bytes,
                RAW_DIAGNOSTIC
            );
            assert!(no_root_run
                .auxiliary_artifacts
                .iter()
                .all(|artifact| artifact
                    .relative_path
                    .starts_with("eigen/diagnostics/raw_single_k/sample_0000/")));
            assert_eq!(
                no_root_run
                    .auxiliary_artifacts
                    .iter()
                    .find(|artifact| {
                        artifact.relative_path
                            == "eigen/diagnostics/raw_single_k/sample_0000/point-plan.json"
                    })
                    .expect("namespaced raw point plan")
                    .bytes,
                serde_json::to_vec(&point_plan).expect("serialized point plan")
            );
            assert!(!no_root_run
                .auxiliary_artifacts
                .iter()
                .any(|artifact| artifact.relative_path == "eigen/spectrum.json"));
            assert!(!no_root_run.auxiliary_artifacts.iter().any(|artifact| {
                artifact.relative_path.starts_with("eigen/modes/")
                    || artifact.relative_path.starts_with("equilibrium/")
            }));
            let no_root_manifest = no_root_run
                .auxiliary_artifacts
                .iter()
                .find(|artifact| {
                    artifact.relative_path
                        == "eigen/diagnostics/raw_single_k/sample_0000/manifest.json"
                })
                .expect("sample/status diagnostic manifest");
            let no_root_manifest: serde_json::Value =
                serde_json::from_slice(&no_root_manifest.bytes).expect("manifest JSON");
            assert_eq!(
                no_root_manifest["result_disposition"],
                "raw_native_interrupted_nonaccepted"
            );
            assert_eq!(
                no_root_manifest["run_status"],
                expected_terminal_status_label(status)
            );
            assert_eq!(no_root_manifest["sample_index"], 0);
            assert_eq!(
                no_root_manifest["requested_global_k_rad_per_m"],
                serde_json::json!([0.0, 0.0, 0.0])
            );
            assert_eq!(
                no_root_manifest["execution_provenance"]["fem_eigen_execution_resolution"]
                    ["selection_reason"],
                "test.single_k_checkpoint_admission"
            );
            let mut unsafe_run = run.clone();
            unsafe_run.auxiliary_artifacts[0].relative_path = "../outside.json".into();
            assert!(
                checkpoint_and_admit_single_k(None, &sample, &point_plan, &unsafe_run).is_err()
            );

            let checkpoint_root = TestDirectory::new();
            let with_root = match checkpoint_and_admit_single_k(
                Some(checkpoint_root.path()),
                &sample,
                &point_plan,
                &run,
            )
            .expect("disk diagnostic checkpoint without a spectrum")
            {
                SingleKCheckpointAdmission::Interrupted(interrupted) => interrupted,
                SingleKCheckpointAdmission::Completed => {
                    panic!("an interrupted status must not be admitted")
                }
            };
            assert!(with_root.diagnostic_artifacts.is_empty());
            let sample_root = checkpoint_root
                .path()
                .join("eigen/sample-checkpoints/sample-0000");
            assert_eq!(
                fs::read(sample_root.join("artifacts/eigen/diagnostics/solver.v1.json"))
                    .expect("disk raw diagnostic"),
                RAW_DIAGNOSTIC
            );
            assert_eq!(
                fs::read(sample_root.join("point-plan.json")).expect("disk point plan"),
                serde_json::to_vec(&point_plan).expect("serialized point plan")
            );
            assert!(!sample_root.join("artifacts/eigen/spectrum.json").exists());
            let checkpoint_manifest: serde_json::Value = serde_json::from_slice(
                &fs::read(sample_root.join("manifest.json")).expect("checkpoint manifest"),
            )
            .expect("checkpoint manifest JSON");
            assert_eq!(
                checkpoint_manifest["result_disposition"],
                "raw_native_interrupted_nonaccepted"
            );
            assert_eq!(
                checkpoint_manifest["run_status"],
                expected_terminal_status_label(status)
            );
            assert_eq!(checkpoint_manifest["sample_index"], 0);
            assert_eq!(
                checkpoint_manifest["execution_provenance"]["fem_eigen_execution_resolution"]
                    ["selection_reason"],
                "test.single_k_checkpoint_admission"
            );
        }
    }

    #[test]
    fn interrupted_checkpoint_write_failure_is_not_returned_as_cancelled() {
        let plan = three_sample_plan();
        let sample = crate::eigen::expand_k_sampling(plan.k_sampling.as_ref())
            .expect("valid test path")
            .remove(0);
        let point_plan =
            eigen_path_single_k_point_plan(&plan, &sample, false, None).expect("valid point plan");
        let run = ExecutedRun {
            result: RunResult {
                status: RunStatus::Cancelled,
                steps: Vec::new(),
                final_magnetization: vec![[9.0, 8.0, 7.0]; plan.mesh.nodes.len()],
                completion: None,
            },
            initial_magnetization: plan.equilibrium_magnetization.clone(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: vec![AuxiliaryArtifact {
                relative_path: "eigen/diagnostics/solver.v1.json".into(),
                bytes: b"diagnostic".to_vec(),
            }],
            provenance: ExecutionProvenance::default(),
        };
        let checkpoint_root = TestDirectory::new();
        let blocked_sample_root = checkpoint_root
            .path()
            .join("eigen/sample-checkpoints/sample-0000");
        fs::create_dir_all(&blocked_sample_root).expect("create conflicting checkpoint path");

        let admission =
            checkpoint_and_admit_single_k(Some(checkpoint_root.path()), &sample, &point_plan, &run);

        assert!(admission.is_err());
    }
}
