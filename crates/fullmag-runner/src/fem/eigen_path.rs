//! FEM eigen path orchestration and dispersion artifacts.

use fullmag_ir::{FemEigenPlanIR, OutputIR};

use crate::eigen::{
    run_path_or_single, EigenSolverModel, KSampleDescriptor, PathSolveResult, SingleKModeResult,
    SingleKSolveResult, SingleKSolver,
};
use crate::fem_eigen;
use crate::solver_runtime::engine::FemEngine;
use crate::types::{
    AuxiliaryArtifact, ExecutedRun, ExecutionProvenance, RunError, RunResult, RunStatus,
};

struct KSolverAdapter {
    engine: FemEngine,
}

impl SingleKSolver for KSolverAdapter {
    fn solve_single_k(
        &self,
        plan: &FemEigenPlanIR,
        outputs: &[OutputIR],
        sample: &KSampleDescriptor,
    ) -> Result<SingleKSolveResult, RunError> {
        let mut point_plan = plan.clone();
        point_plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: sample.k_vector,
        });

        let executed = match self.engine {
            FemEngine::CpuNative => fem_eigen::execute_baseline_fem_eigen(&point_plan, outputs)?,
            FemEngine::NativeGpu => fem_eigen::execute_gpu_fem_eigen(&point_plan, outputs)?,
        };

        let spectrum_bytes = executed
            .auxiliary_artifacts
            .iter()
            .find(|a| a.relative_path == "eigen/spectrum.json")
            .map(|a| &a.bytes)
            .ok_or_else(|| RunError {
                message: "single-k solver did not produce eigen/spectrum.json".to_string(),
            })?;
        let spectrum: serde_json::Value =
            serde_json::from_slice(spectrum_bytes).map_err(|e| RunError {
                message: format!("failed to parse spectrum.json: {e}"),
            })?;
        let relaxation_steps = spectrum["relaxation_steps"].as_u64().unwrap_or(0);
        let solver_kind = spectrum["solver_kind"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        let modes_array = spectrum["modes"].as_array().ok_or_else(|| RunError {
            message: "spectrum.json has no modes array".to_string(),
        })?;

        let mut modes = Vec::with_capacity(modes_array.len());
        for mode_json in modes_array {
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
                max_amplitude: mode_json["max_amplitude"].as_f64().unwrap_or(0.0),
                residual_norm: mode_json["residual_norm"].as_f64(),
                residual_linf: mode_json["residual_linf"].as_f64(),
                tangent_leakage_mean_abs: mode_json["tangent_leakage_mean_abs"].as_f64(),
                tangent_leakage_max_abs: mode_json["tangent_leakage_max_abs"].as_f64(),
                dominant_polarization: mode_json["dominant_polarization"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                reduced_vector: None,
                lifted_real: None,
                lifted_imag: None,
                amplitude: None,
                phase: None,
                node_mass_weights: None,
            });
        }

        Ok(SingleKSolveResult {
            sample: sample.clone(),
            modes,
            relaxation_steps,
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            solver_notes: vec![solver_kind],
        })
    }
}

/// Multi-k orchestrator path: iterate over samples in a `KSamplingIR::Path`,
/// solve each point with the existing single-k solver, track branches, and
/// produce V2 path/branch/mode artifacts alongside legacy-compatible ones.
pub(crate) fn execute_fem_eigen_path(
    engine: FemEngine,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    let adapter = KSolverAdapter { engine };
    let path_result =
        run_path_or_single(&adapter, plan, outputs, None, plan.mode_tracking.as_ref())?;

    let mut auxiliary_artifacts = Vec::new();

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
                "modes": s.modes.iter().map(|m| serde_json::json!({
                    "raw_mode_index": m.raw_mode_index,
                    "branch_id": m.branch_id,
                    "frequency_real_hz": m.frequency_real_hz,
                    "frequency_imag_hz": m.frequency_imag_hz,
                    "angular_frequency_rad_per_s": m.angular_frequency_rad_per_s,
                    "eigenvalue_real": m.eigenvalue_real,
                    "eigenvalue_imag": m.eigenvalue_imag,
                    "norm": m.norm,
                    "max_amplitude": m.max_amplitude,
                    "dominant_polarization": m.dominant_polarization,
                    "k_vector": s.sample.k_vector,
                })).collect::<Vec<_>>(),
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
        .flat_map(|branch| branch.points.iter().filter_map(|point| point.overlap_prev))
        .collect::<Vec<_>>();
    let min_overlap = overlap_values
        .iter()
        .copied()
        .reduce(|lhs, rhs| lhs.min(rhs));
    let gap_count = path_result
        .branches
        .iter()
        .map(|branch| v2_samples.len().saturating_sub(branch.points.len()))
        .sum::<usize>();
    let diagnostics_v2 = serde_json::json!({
        "schema_version": "eigen_diagnostics.v2",
        "dispersion": {
            "sample_count": path_result.samples.len(),
            "mode_count_requested": plan.count,
            "branch_count": path_result.branches.len(),
            "min_overlap": min_overlap,
            "gap_count": gap_count,
            "ambiguous_assignment_count": 0,
        },
    });
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_id": path_result.solver_model.as_str(),
        "phase_convention": phase_convention,
        "samples": v2_samples.clone(),
        "diagnostics_summary": diagnostics_v2["dispersion"].clone(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/spectrum.v2.json".to_string(),
        bytes: serde_json::to_vec_pretty(&spectrum_v2).unwrap_or_default(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/path.json".to_string(),
        bytes: serde_json::to_vec_pretty(&path_json).unwrap_or_default(),
    });

    let v2_branches: Vec<serde_json::Value> = path_result
        .branches
        .iter()
        .map(|b| {
            serde_json::json!({
                "branch_id": b.branch_id,
                "label": b.label,
                "points": b.points.iter().map(|p| serde_json::json!({
                    "sample_index": p.sample_index,
                    "raw_mode_index": p.raw_mode_index,
                    "frequency_real_hz": p.frequency_real_hz,
                    "frequency_imag_hz": p.frequency_imag_hz,
                    "tracking_confidence": p.tracking_confidence,
                    "overlap_prev": p.overlap_prev,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let branches_v2 = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "tracking_method": tracking_method,
        "overlap_floor": tracking_cfg.overlap_floor,
        "frequency_window_hz": tracking_cfg.frequency_window_hz,
        "branches": v2_branches.clone(),
        "diagnostics": {
            "min_overlap": min_overlap,
            "median_overlap": null,
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

    if let Some(first_sample) = path_result.samples.first() {
        record_legacy_eigen_path_artifacts(
            &mut auxiliary_artifacts,
            plan,
            &path_result,
            first_sample,
        );
    }

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![],
            final_magnetization: plan.equilibrium_magnetization.clone(),
            completion: Some(crate::relaxation::infer_stage_completion(
                RunStatus::Completed,
                None,
                &[],
                0.0,
                0.0,
                false,
            )),
        },
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: ExecutionProvenance {
            execution_engine: format!("multi_k_orchestrator/{}", path_result.solver_model.as_str()),
            precision: "double".to_string(),
            ..Default::default()
        },
    })
}

fn record_legacy_eigen_path_artifacts(
    auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
    plan: &FemEigenPlanIR,
    path_result: &PathSolveResult,
    first_sample: &SingleKSolveResult,
) {
    let modes_summary: Vec<serde_json::Value> = first_sample
        .modes
        .iter()
        .map(|m| {
            serde_json::json!({
                "index": m.raw_mode_index,
                "frequency_hz": m.frequency_real_hz,
                "frequency_real_hz": m.frequency_real_hz,
                "frequency_imag_hz": m.frequency_imag_hz,
                "angular_frequency_rad_per_s": m.angular_frequency_rad_per_s,
                "eigenvalue_real": m.eigenvalue_real,
                "eigenvalue_imag": m.eigenvalue_imag,
                "norm": m.norm,
                "max_amplitude": m.max_amplitude,
                "dominant_polarization": m.dominant_polarization,
                "k_vector": first_sample.sample.k_vector,
            })
        })
        .collect();

    let legacy_spectrum = serde_json::json!({
        "study_kind": "eigenmodes",
        "solver_backend": "cpu_baseline_fem_eigen",
        "solver_kind": path_result.solver_model.as_str(),
        "mesh_name": plan.mesh_name,
        "mode_count": modes_summary.len(),
        "normalization": format!("{:?}", plan.normalization).to_lowercase(),
        "damping_policy": format!("{:?}", plan.damping_policy).to_lowercase(),
        "k_sampling": plan.k_sampling,
        "relaxation_steps": first_sample.relaxation_steps,
        "modes": modes_summary,
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/spectrum.json".to_string(),
        bytes: serde_json::to_vec_pretty(&legacy_spectrum).unwrap_or_default(),
    });

    let mut csv_lines =
        vec!["mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s".to_string()];
    for sample_result in &path_result.samples {
        let k = sample_result.sample.k_vector;
        for mode in &sample_result.modes {
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
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score"
            .to_string(),
    ];
    for sample_result in &path_result.samples {
        let k = sample_result.sample.k_vector;
        let label = sample_result.sample.label.clone().unwrap_or_default();
        for mode in &sample_result.modes {
            let overlap_score = mode
                .branch_id
                .and_then(|branch_id| {
                    path_result
                        .branches
                        .iter()
                        .find(|branch| branch.branch_id == branch_id)
                        .and_then(|branch| {
                            branch.points.iter().find(|point| {
                                point.sample_index == sample_result.sample.sample_index
                                    && point.raw_mode_index == mode.raw_mode_index
                            })
                        })
                        .and_then(|point| point.overlap_prev)
                })
                .map(|value| value.to_string())
                .unwrap_or_default();
            dispersion_v2_lines.push(format!(
                "{},{},{},{},{},{},{},{},{},{},{},{},{}",
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
                "",
                mode.residual_norm
                    .map(|value| format!("{value:.16e}"))
                    .unwrap_or_default(),
                overlap_score,
            ));
        }
    }
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/dispersion.csv".to_string(),
        bytes: dispersion_v2_lines.join("\n").into_bytes(),
    });

    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/dispersion/path.json".to_string(),
        bytes: serde_json::to_vec_pretty(&serde_json::json!({
            "sampling": plan.k_sampling,
        }))
        .unwrap_or_default(),
    });
}
