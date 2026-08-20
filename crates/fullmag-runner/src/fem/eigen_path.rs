//! FEM eigen path orchestration and dispersion artifacts.

use fullmag_ir::{FemEigenPlanIR, OutputIR};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};

use crate::dispatch::FemEngine;
use crate::fem::eigen_execution_resolution::{FemEigenExecutionLane, PlannedFemEigenExecution};
use crate::fem_eigen;
use crate::types::{AuxiliaryArtifact, ExecutedRun, RunError};

#[path = "eigen_path_artifacts.rs"]
mod eigen_path_artifacts;
#[path = "eigen_path_guards.rs"]
mod eigen_path_guards;
#[path = "eigen_path_manifest.rs"]
mod eigen_path_manifest;
use eigen_path_artifacts::*;
use eigen_path_guards::*;
use eigen_path_manifest::*;

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

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
        super::eigen_path_solver_diagnostics(engine, plan, result, published_mode_indices)
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
        super::build_eigen_path_frequency_domain_manifest(engine, result, mode_artifacts, plan)
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
}

fn bind_eigen_path_handoff_diagnostics(
    diagnostics: &mut serde_json::Value,
    sample_index: usize,
    handoff_sha256: &str,
    source_mesh_topology_sha256: &str,
) {
    let bind = |value: &mut serde_json::Value| {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "relax_to_eigen_handoff_sha256".to_string(),
                serde_json::json!(handoff_sha256),
            );
            object.insert(
                "source_mesh_topology_sha256".to_string(),
                serde_json::json!(source_mesh_topology_sha256),
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
) -> Result<ExecutedRun, RunError> {
    let engine = match execution.lane() {
        FemEigenExecutionLane::Cpu => FemEngine::CpuNative,
        FemEigenExecutionLane::Gpu => FemEngine::NativeGpu,
    };
    if engine == FemEngine::NativeGpu && !gpu_modal_k0_kittel_path_supported(plan) {
        return Err(gpu_modal_dispersion_path_unavailable_error(plan));
    }
    if !de_bv_low_k_analytic_reference_enabled(plan)
        && !(k0_kittel_synthetic_demag_factor_enabled(plan) && !bias_field_sweep_requested(plan))
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

    struct KSolverAdapter<'a> {
        execution: PlannedFemEigenExecution<'a>,
        engine: FemEngine,
        mode_artifacts: RefCell<Vec<AuxiliaryArtifact>>,
        mode_artifact_indices: BTreeSet<u32>,
        relax_handoff: RefCell<Option<fem_eigen::AcceptedFemEigenEquilibriumHandoff>>,
        periodic_airbox_k0_metrics:
            RefCell<Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>>,
    }

    impl SingleKSolver for KSolverAdapter<'_> {
        fn solve_single_k(
            &self,
            plan: &FemEigenPlanIR,
            outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveResult, crate::types::RunError> {
            if de_bv_low_k_analytic_reference_enabled(plan) {
                return solve_de_bv_low_k_analytic_reference_single_k(plan, sample);
            }
            if k0_kittel_synthetic_demag_factor_enabled(plan) && plan.bias_field_samples.is_empty()
            {
                return solve_k0_kittel_synthetic_demag_factor_single_k(plan, sample);
            }

            let existing_handoff = self.relax_handoff.borrow().clone();
            let mut accepted_handoff = existing_handoff.clone();
            let point_plan = eigen_path_single_k_point_plan(
                plan,
                sample,
                existing_handoff.is_some(),
                existing_handoff.as_ref(),
            )?;

            let executed = if self.execution.resolution().is_some() {
                fem_eigen::execute_planned_fem_eigen_with_handoff(
                    self.execution,
                    &point_plan,
                    outputs,
                    existing_handoff.as_ref(),
                )?
            } else {
                match self.engine {
                    FemEngine::CpuNative => fem_eigen::execute_cpu_fem_eigen_with_handoff(
                        &point_plan,
                        outputs,
                        existing_handoff.as_ref(),
                    )?,
                    FemEngine::NativeGpu => fem_eigen::execute_gpu_fem_eigen_with_handoff(
                        &point_plan,
                        outputs,
                        None,
                        existing_handoff.as_ref(),
                    )?,
                }
            };
            if existing_handoff.is_none()
                && !bias_field_sweep_requested(plan)
                && matches!(
                    plan.equilibrium,
                    fullmag_ir::EquilibriumSourceIR::RelaxedInitialState
                )
            {
                let accepted =
                    fem_eigen::accepted_relax_to_eigen_handoff_from_run(&point_plan, &executed)?;
                accepted_handoff = Some(accepted.clone());
                *self.relax_handoff.borrow_mut() = Some(accepted);
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
            self.mode_artifacts
                .borrow_mut()
                .extend(remap_single_k_mode_artifacts(
                    &executed.auxiliary_artifacts,
                    sample.sample_index,
                    &self.mode_artifact_indices,
                )?);

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
            let node_mass_weights =
                eigen_path_node_mass_weights_from_json(&spectrum["node_mass_weights"]);

            let mut modes = Vec::with_capacity(modes_array.len());
            for mode_json in modes_array {
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
                    raw_mode_index: mode_json["index"].as_u64().unwrap_or(0) as usize,
                    branch_id: None,
                    frequency_real_hz: mode_json["frequency_real_hz"].as_f64().unwrap_or(0.0),
                    frequency_imag_hz: mode_json["frequency_imag_hz"].as_f64().unwrap_or(0.0),
                    angular_frequency_rad_per_s: mode_json["angular_frequency_rad_per_s"]
                        .as_f64()
                        .unwrap_or(0.0),
                    eigenvalue_real: mode_json["eigenvalue_real"].as_f64().unwrap_or(0.0),
                    eigenvalue_imag: mode_json["eigenvalue_imag"].as_f64().unwrap_or(0.0),
                    norm: mode_json["norm"].as_f64().unwrap_or(0.0),
                    mass_norm: mode_json["mass_norm"].as_f64(),
                    max_amplitude: mode_json["max_amplitude"].as_f64().unwrap_or(0.0),
                    residual_norm: mode_json["residual_norm"].as_f64(),
                    residual_linf: mode_json["residual_linf"].as_f64(),
                    tangent_leakage_mean_abs: mode_json["tangent_leakage_mean_abs"].as_f64(),
                    tangent_leakage_max_abs: mode_json["tangent_leakage_max_abs"].as_f64(),
                    dominant_polarization: mode_json["dominant_polarization"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    reduced_vector: eigen_path_mode_tracking_vector(
                        &executed.auxiliary_artifacts,
                        mode_json["index"].as_u64().unwrap_or(0) as usize,
                    ),
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: node_mass_weights.clone(),
                    component_participation,
                });
            }

            let mut solver_diagnostics = spectrum.get("solver_diagnostics").cloned();
            if let (Some(diagnostics), Some(handoff)) =
                (solver_diagnostics.as_mut(), accepted_handoff.as_ref())
            {
                bind_eigen_path_handoff_diagnostics(
                    diagnostics,
                    sample.sample_index,
                    handoff.content_sha256(),
                    handoff.source_mesh_topology_sha256(),
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
    let published_mode_indices = eigen_path_public_mode_indices(outputs, plan.count);
    let mode_artifact_indices = eigen_path_mode_artifact_indices(outputs);
    let mode_fields_requested = !mode_artifact_indices.is_empty();
    let wants_dispersion = eigen_path_wants_dispersion(outputs);
    let adapter = KSolverAdapter {
        execution,
        engine,
        mode_artifacts: RefCell::new(Vec::new()),
        mode_artifact_indices,
        relax_handoff: RefCell::new(None),
        periodic_airbox_k0_metrics: RefCell::new(None),
    };
    let mut path_result = run_path_or_single(
        &adapter,
        plan,
        &tracking_outputs,
        None, // we collect artifacts manually below
        plan.mode_tracking.as_ref(),
    )?;
    path_result.k0_kittel_periodic_airbox_demag = adapter.periodic_airbox_k0_metrics.into_inner();
    if path_result.k0_kittel_periodic_airbox_demag.is_some() && engine == FemEngine::CpuNative {
        path_result.solver_model = crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    }
    if periodic_airbox_k0_runtime_supported(plan) && engine == FemEngine::NativeGpu {
        path_result.solver_model = crate::eigen::EigenSolverModel::ProductionGpuModalDeviceKrylov;
    }
    let mut mode_artifacts = adapter.mode_artifacts.into_inner();
    deduplicate_auxiliary_artifacts_by_path(&mut mode_artifacts);
    // Analytic reference solvers do not synthesize topology-bound mode fields
    // unless the caller explicitly requested EigenMode output.  In particular,
    // an EigenSpectrum-only K0 field sweep must not trigger a hidden mode-bundle
    // write and then fail on a mesh identity that was never requested.
    if mode_artifacts.is_empty()
        && mode_fields_requested
        && (de_bv_low_k_analytic_reference_enabled(plan)
            || (k0_kittel_synthetic_demag_factor_enabled(plan)
                && !bias_field_sweep_requested(plan)))
    {
        mode_artifacts = eigen_path_mode_artifacts_from_result(&path_result)?;
    }

    // Build the ExecutedRun with both V2 and legacy-compatible artifacts
    let mut auxiliary_artifacts = Vec::new();

    // V2 path artifact (eigen/path.json)
    let v2_samples: Vec<serde_json::Value> = path_result
        .samples
        .iter()
        .map(|s| {
            serde_json::json!({
                "sample_index": s.sample.sample_index,
                "label": s.sample.label,
                "k_vector": s.sample.k_vector,
                "path_s": s.sample.path_s,
                "segment_index": s.sample.segment_index,
                "t_in_segment": s.sample.t_in_segment,
                "modes": s
                    .modes
                    .iter()
                    .filter(|m| published_mode_indices.contains(&(m.raw_mode_index as u32)))
                    .map(|m| {
                        eigen_path_mode_json(
                            plan,
                            &s.sample,
                            m,
                            path_result.solver_model,
                            s.solver_diagnostics.as_ref(),
                        )
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
    let tracking_cfg = plan.mode_tracking.clone().unwrap_or_default();
    let tracking_method = serde_json::to_value(tracking_cfg.method)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "overlap_hungarian".to_string());
    let phase_convention = serde_json::to_value(plan.spin_wave_bc.phase_convention())
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "exp_minus_i_k_dot_delta_r".to_string());
    let overlap_values = path_result
        .branches
        .iter()
        .flat_map(|branch| {
            branch
                .points
                .iter()
                .filter(|point| published_mode_indices.contains(&(point.raw_mode_index as u32)))
                .filter_map(|point| point.overlap_prev)
        })
        .collect::<Vec<_>>();
    let min_overlap = overlap_values
        .iter()
        .copied()
        .reduce(|lhs, rhs| lhs.min(rhs));
    let median_overlap = median_f64(&overlap_values);
    let (tracking_score_source, modal_overlap_available) =
        eigen_path_tracking_score_summary(&path_result);
    let modal_overlap_unavailable_reason = if modal_overlap_available {
        serde_json::Value::Null
    } else {
        serde_json::json!("mode_vectors_not_carried_by_multi_k_orchestrator")
    };
    let gap_count = path_result
        .branches
        .iter()
        .map(|branch| v2_samples.len().saturating_sub(branch.points.len()))
        .sum::<usize>();
    let public_mode_count = eigen_path_public_mode_count(&path_result, &published_mode_indices);
    let diagnostics_v2 = serde_json::json!({
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
            "ambiguous_assignment_count": 0,
        },
    });
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_id": path_result.solver_model.as_str(),
        "phase_convention": phase_convention,
        "sample_count": v2_samples.len(),
        "mode_count": public_mode_count,
        "samples": v2_samples.clone(),
        "diagnostics_summary": diagnostics_v2["dispersion"].clone(),
    });
    let spectrum_v3_samples = path_result
        .samples
        .iter()
        .map(|sample| {
            serde_json::json!({
                "sample_id": format!("bias-field-sample-{:04}", sample.sample.sample_index),
                "sample_index": sample.sample.sample_index,
                "label": sample.sample.label,
                "k_vector": sample.sample.k_vector,
                "path_s": sample.sample.path_s,
                "segment_index": sample.sample.segment_index,
                "t_in_segment": sample.sample.t_in_segment,
                "modes": sample
                    .modes
                    .iter()
                    .filter(|mode| published_mode_indices.contains(&(mode.raw_mode_index as u32)))
                    .map(|mode| {
                        eigen_path_mode_v3_json(
                            plan,
                            &sample.sample,
                            mode,
                            path_result.solver_model,
                            sample.solver_diagnostics.as_ref(),
                        )
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
        "diagnostics_summary": diagnostics_v2["dispersion"].clone(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/spectrum.v2.json".to_string(),
        bytes: serde_json::to_vec_pretty(&spectrum_v2).unwrap_or_default(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/spectrum.v3.json".to_string(),
        bytes: serde_json::to_vec_pretty(&spectrum_v3).unwrap_or_default(),
    });
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
                .filter(|(_, p)| published_mode_indices.contains(&(p.raw_mode_index as u32)))
                .map(|(point_index, p)| {
                    let mode = eigen_path_mode_for_branch_point(&path_result, p);
                    let point_modal_overlap_available =
                        eigen_path_branch_point_modal_overlap_available(&path_result, b, point_index);
                    serde_json::json!({
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
                        "mode_field_id": eigen_path_mode_field_id(
                            p.sample_index,
                            p.raw_mode_index,
                        ),
                        "mode_field_resource_key": eigen_path_mode_field_resource_key(
                            p.sample_index,
                            p.raw_mode_index,
                        ),
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
    let branches_v2 = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "tracking_method": tracking_method,
        "tracking_score_source": tracking_score_source,
        "modal_overlap_available": modal_overlap_available,
        "overlap_floor": tracking_cfg.overlap_floor,
        "frequency_window_hz": tracking_cfg.frequency_window_hz,
        "branches": v2_branches.clone(),
        "diagnostics": {
            "min_overlap": min_overlap,
            "median_overlap": median_overlap,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": modal_overlap_unavailable_reason,
            "gap_count": gap_count,
            "ambiguous_assignment_count": 0,
        },
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/branches.v2.json".to_string(),
        bytes: serde_json::to_vec_pretty(&branches_v2).unwrap_or_default(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/diagnostics.v2.json".to_string(),
        bytes: serde_json::to_vec_pretty(&diagnostics_v2).unwrap_or_default(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/branches.json".to_string(),
        bytes: serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "2",
            "solver_model": path_result.solver_model.as_str(),
            "branches": v2_branches,
        }))
        .unwrap_or_default(),
    });

    // Legacy-compatible spectrum.json from the first sample
    if let Some(first_sample) = path_result.samples.first() {
        let modes_summary: Vec<serde_json::Value> = first_sample
            .modes
            .iter()
            .filter(|m| published_mode_indices.contains(&(m.raw_mode_index as u32)))
            .map(|m| {
                eigen_path_mode_v3_json(
                    plan,
                    &first_sample.sample,
                    m,
                    path_result.solver_model,
                    first_sample.solver_diagnostics.as_ref(),
                )
            })
            .collect();
        let solver_diagnostics =
            eigen_path_solver_diagnostics(engine, plan, &path_result, &published_mode_indices);
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
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/diagnostics/solver.v1.json".to_string(),
            bytes: serde_json::to_vec_pretty(&solver_diagnostics).unwrap_or_default(),
        });

        if wants_dispersion {
            // Legacy dispersion CSV with all samples × modes
            let mut csv_lines =
                vec!["mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s".to_string()];
            for sample_result in &path_result.samples {
                let k = sample_result.sample.k_vector;
                for mode in &sample_result.modes {
                    if !published_mode_indices.contains(&(mode.raw_mode_index as u32)) {
                        continue;
                    }
                    csv_lines.push(format!(
                        "{},{},{},{},{},{}",
                        mode.raw_mode_index,
                        k[0],
                        k[1],
                        k[2],
                        mode.frequency_real_hz,
                        mode.angular_frequency_rad_per_s,
                    ));
                }
            }
            auxiliary_artifacts.push(AuxiliaryArtifact {
                relative_path: "eigen/dispersion/branch_table.csv".to_string(),
                bytes: csv_lines.join("\n").into_bytes(),
            });

            let mut dispersion_v2_lines = vec![
            "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key"
                .to_string(),
        ];
            for sample_result in &path_result.samples {
                let k = sample_result.sample.k_vector;
                let label = sample_result.sample.label.clone().unwrap_or_default();
                for mode in &sample_result.modes {
                    if !published_mode_indices.contains(&(mode.raw_mode_index as u32)) {
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
                    let validation_columns =
                        eigen_path_de_bv_analytic_csv_columns(plan, &sample_result.sample, mode);
                    dispersion_v2_lines.push(format!(
                        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                        sample_result.sample.sample_index,
                        sample_result.sample.path_s,
                        k[0],
                        k[1],
                        k[2],
                        label,
                        mode.raw_mode_index,
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
                        eigen_path_mode_field_id(
                            sample_result.sample.sample_index,
                            mode.raw_mode_index,
                        ),
                        eigen_path_mode_field_resource_key(
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
    append_eigen_path_k0_kittel_validation_artifacts(&mut auxiliary_artifacts, &path_result)?;
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "frequency_domain/manifest.v1.json".to_string(),
        bytes: serde_json::to_vec_pretty(&build_eigen_path_frequency_domain_manifest(
            engine,
            &path_result,
            &mode_artifacts,
            plan,
        ))
        .map_err(|error| RunError {
            message: format!("failed to serialize k-path frequency-domain manifest: {error}"),
        })?,
    });
    auxiliary_artifacts.extend(mode_artifacts);

    Ok(ExecutedRun {
        result: crate::types::RunResult {
            status: crate::types::RunStatus::Completed,
            steps: vec![],
            final_magnetization: plan.equilibrium_magnetization.clone(),
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
