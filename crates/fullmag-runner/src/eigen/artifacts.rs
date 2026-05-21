use crate::eigen::response_block_real::FieldDrivenResponseSweepArtifact;
use crate::eigen::types::{PathSolveResult, SingleKModeResult, SingleKSolveResult};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
struct ModeSummaryArtifact {
    raw_mode_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<usize>,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    angular_frequency_rad_per_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    norm: f64,
    max_amplitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_norm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_linf: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_mean_abs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_max_abs: Option<f64>,
    dominant_polarization: String,
    k_vector: [f64; 3],
}

#[derive(Debug, Clone, Serialize)]
struct SampleArtifact {
    sample_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    k_vector: [f64; 3],
    path_s: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    segment_index: Option<usize>,
    t_in_segment: f64,
    modes: Vec<ModeSummaryArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct PathArtifact<'a> {
    schema_version: &'static str,
    solver_model: &'a str,
    sample_count: usize,
    samples: Vec<SampleArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct BranchPointArtifact {
    sample_index: usize,
    raw_mode_index: usize,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    tracking_confidence: f64,
    overlap_prev: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct BranchArtifact {
    branch_id: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    points: Vec<BranchPointArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct BranchesArtifact {
    schema_version: &'static str,
    solver_model: String,
    branches: Vec<BranchArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct ModeArtifact<'a> {
    schema_version: &'static str,
    solver_model: &'a str,
    sample_index: usize,
    raw_mode_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<usize>,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    angular_frequency_rad_per_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    normalization: &'static str,
    damping_policy: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_norm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_linf: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_mean_abs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_max_abs: Option<f64>,
    dominant_polarization: &'a str,
    k_vector: [f64; 3],
    real: &'a [[f64; 3]],
    imag: &'a [[f64; 3]],
    amplitude: &'a [f64],
    phase: &'a [f64],
}

fn summarize_mode(sample: &SingleKSolveResult, mode: &SingleKModeResult) -> ModeSummaryArtifact {
    ModeSummaryArtifact {
        raw_mode_index: mode.raw_mode_index,
        branch_id: mode.branch_id,
        frequency_real_hz: mode.frequency_real_hz,
        frequency_imag_hz: mode.frequency_imag_hz,
        angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
        eigenvalue_real: mode.eigenvalue_real,
        eigenvalue_imag: mode.eigenvalue_imag,
        norm: mode.norm,
        max_amplitude: mode.max_amplitude,
        residual_norm: mode.residual_norm,
        residual_linf: mode.residual_linf,
        tangent_leakage_mean_abs: mode.tangent_leakage_mean_abs,
        tangent_leakage_max_abs: mode.tangent_leakage_max_abs,
        dominant_polarization: mode.dominant_polarization.clone(),
        k_vector: sample.sample.k_vector,
    }
}

pub fn write_response_sweep_artifact(
    base_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
) -> std::io::Result<()> {
    let response_dir = base_dir.join("response");
    fs::create_dir_all(&response_dir)?;
    fs::write(
        response_dir.join("magnetic_response_sweep.v1.json"),
        serde_json::to_vec_pretty(artifact).unwrap(),
    )?;
    Ok(())
}

pub fn write_path_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    let eigen_dir = base_dir.join("eigen");
    fs::create_dir_all(&eigen_dir)?;
    let samples: Vec<SampleArtifact> = result
        .samples
        .iter()
        .map(|sample| SampleArtifact {
            sample_index: sample.sample.sample_index,
            label: sample.sample.label.clone(),
            k_vector: sample.sample.k_vector,
            path_s: sample.sample.path_s,
            segment_index: sample.sample.segment_index,
            t_in_segment: sample.sample.t_in_segment,
            modes: sample
                .modes
                .iter()
                .map(|mode| summarize_mode(sample, mode))
                .collect(),
        })
        .collect();
    let spectrum_artifact = PathArtifact {
        schema_version: "eigen_spectrum.v2",
        solver_model: result.solver_model.as_str(),
        sample_count: samples.len(),
        samples: samples.clone(),
    };
    fs::write(
        eigen_dir.join("spectrum.v2.json"),
        serde_json::to_vec_pretty(&spectrum_artifact).unwrap(),
    )?;
    let path_artifact = PathArtifact {
        schema_version: "2",
        solver_model: result.solver_model.as_str(),
        sample_count: samples.len(),
        samples: samples.clone(),
    };
    fs::write(
        eigen_dir.join("path.json"),
        serde_json::to_vec_pretty(&path_artifact).unwrap(),
    )?;
    fs::write(
        eigen_dir.join("samples.json"),
        serde_json::to_vec_pretty(&samples).unwrap(),
    )?;
    Ok(())
}

pub fn write_branch_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    let eigen_dir = base_dir.join("eigen");
    fs::create_dir_all(&eigen_dir)?;
    let branches: Vec<BranchArtifact> = result
        .branches
        .iter()
        .map(|branch| BranchArtifact {
            branch_id: branch.branch_id,
            label: branch.label.clone(),
            points: branch
                .points
                .iter()
                .map(|point| BranchPointArtifact {
                    sample_index: point.sample_index,
                    raw_mode_index: point.raw_mode_index,
                    frequency_real_hz: point.frequency_real_hz,
                    frequency_imag_hz: point.frequency_imag_hz,
                    tracking_confidence: point.tracking_confidence,
                    overlap_prev: point.overlap_prev,
                })
                .collect(),
        })
        .collect();
    let branches_v2 = BranchesArtifact {
        schema_version: "eigen_branches.v2",
        solver_model: result.solver_model.as_str().to_string(),
        branches: branches.clone(),
    };
    fs::write(
        eigen_dir.join("branches.v2.json"),
        serde_json::to_vec_pretty(&branches_v2).unwrap(),
    )?;
    let payload = BranchesArtifact {
        schema_version: "2",
        solver_model: result.solver_model.as_str().to_string(),
        branches,
    };
    fs::write(
        eigen_dir.join("branches.json"),
        serde_json::to_vec_pretty(&payload).unwrap(),
    )?;

    let mut csv = Vec::<u8>::new();
    writeln!(
        &mut csv,
        "sample_index,branch_id,raw_mode_index,frequency_real_hz,frequency_imag_hz,tracking_confidence,overlap_prev"
    )?;
    for branch in &result.branches {
        for point in &branch.points {
            writeln!(
                &mut csv,
                "{},{},{},{:.16e},{:.16e},{:.6},{}",
                point.sample_index,
                branch.branch_id,
                point.raw_mode_index,
                point.frequency_real_hz,
                point.frequency_imag_hz,
                point.tracking_confidence,
                point
                    .overlap_prev
                    .map(|value| format!("{value:.6}"))
                    .unwrap_or_default(),
            )?;
        }
    }
    fs::write(eigen_dir.join("branch_table.csv"), csv)?;

    let mut dispersion = Vec::<u8>::new();
    writeln!(
        &mut dispersion,
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score"
    )?;
    for sample in &result.samples {
        let k = sample.sample.k_vector;
        let label = sample.sample.label.clone().unwrap_or_default();
        for mode in &sample.modes {
            writeln!(
                &mut dispersion,
                "{},{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{:.16e},{:.16e},{},{},{}",
                sample.sample.sample_index,
                sample.sample.path_s,
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
                resolve_overlap_score(result, sample.sample.sample_index, mode),
            )?;
        }
    }
    fs::write(eigen_dir.join("dispersion.csv"), dispersion)?;
    Ok(())
}

fn resolve_overlap_score(
    result: &PathSolveResult,
    sample_index: usize,
    mode: &SingleKModeResult,
) -> String {
    mode.branch_id
        .and_then(|branch_id| {
            result
                .branches
                .iter()
                .find(|branch| branch.branch_id == branch_id)
                .and_then(|branch| {
                    branch.points.iter().find(|point| {
                        point.sample_index == sample_index
                            && point.raw_mode_index == mode.raw_mode_index
                    })
                })
                .and_then(|point| point.overlap_prev)
        })
        .map(|value| value.to_string())
        .unwrap_or_default()
}

pub fn write_mode_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    let eigen_dir = base_dir.join("eigen").join("modes");
    for sample in &result.samples {
        let sample_dir = eigen_dir.join(format!("sample_{:04}", sample.sample.sample_index));
        fs::create_dir_all(&sample_dir)?;
        for mode in &sample.modes {
            let real = mode.lifted_real.as_deref().unwrap_or(&[]);
            let imag = mode.lifted_imag.as_deref().unwrap_or(&[]);
            let amplitude = mode.amplitude.as_deref().unwrap_or(&[]);
            let phase = mode.phase.as_deref().unwrap_or(&[]);
            let payload = ModeArtifact {
                schema_version: "2",
                solver_model: result.solver_model.as_str(),
                sample_index: sample.sample.sample_index,
                raw_mode_index: mode.raw_mode_index,
                branch_id: mode.branch_id,
                frequency_real_hz: mode.frequency_real_hz,
                frequency_imag_hz: mode.frequency_imag_hz,
                angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
                eigenvalue_real: mode.eigenvalue_real,
                eigenvalue_imag: mode.eigenvalue_imag,
                normalization: "unit_l2",
                damping_policy: "ignore",
                residual_norm: mode.residual_norm,
                residual_linf: mode.residual_linf,
                tangent_leakage_mean_abs: mode.tangent_leakage_mean_abs,
                tangent_leakage_max_abs: mode.tangent_leakage_max_abs,
                dominant_polarization: &mode.dominant_polarization,
                k_vector: sample.sample.k_vector,
                real,
                imag,
                amplitude,
                phase,
            };
            let mode_bytes = serde_json::to_vec_pretty(&payload).unwrap();
            fs::write(
                eigen_dir.join(format!(
                    "sample_{:04}_mode_{:04}.json",
                    sample.sample.sample_index, mode.raw_mode_index
                )),
                &mode_bytes,
            )?;
            fs::write(
                sample_dir.join(format!("mode_{:04}.json", mode.raw_mode_index)),
                mode_bytes,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eigen::response_block_real::{
        build_field_driven_response_sweep_artifact, solve_field_driven_block_real_sweep,
        BlockRealHarmonicTemplate,
    };
    use crate::eigen::types::{
        EigenSolverModel, KSampleDescriptor, PathSolveResult, SingleKModeResult,
        SingleKSolveResult, TrackedBranch, TrackedBranchPoint,
    };
    use nalgebra::{DMatrix, DVector};
    use num_complex::Complex64;
    use serde_json::Value;
    use std::path::PathBuf;

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(slug: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("fullmag-runner-{slug}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("temp test dir should be created");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn sample_result() -> PathSolveResult {
        PathSolveResult {
            samples: vec![SingleKSolveResult {
                sample: KSampleDescriptor {
                    sample_index: 0,
                    label: Some("G".to_string()),
                    segment_index: Some(0),
                    path_s: 0.0,
                    t_in_segment: 0.0,
                    k_vector: [0.0, 0.0, 0.0],
                },
                modes: vec![SingleKModeResult {
                    raw_mode_index: 0,
                    branch_id: Some(0),
                    frequency_real_hz: 1.0e9,
                    frequency_imag_hz: 0.0,
                    angular_frequency_rad_per_s: std::f64::consts::TAU * 1.0e9,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: std::f64::consts::TAU * 1.0e9,
                    norm: 1.0,
                    max_amplitude: 1.0,
                    residual_norm: Some(1.25e-9),
                    residual_linf: Some(2.5e-10),
                    tangent_leakage_mean_abs: Some(3.0e-12),
                    tangent_leakage_max_abs: Some(4.0e-12),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: Some(vec![Complex64::new(1.0, 0.0)]),
                    lifted_real: Some(vec![[1.0, 0.0, 0.0]]),
                    lifted_imag: Some(vec![[0.0, 1.0, 0.0]]),
                    amplitude: Some(vec![1.0]),
                    phase: Some(vec![0.0]),
                }],
                relaxation_steps: 0,
                solver_model: EigenSolverModel::ReferenceScalarTangent,
                solver_notes: vec!["test fixture".to_string()],
            }],
            branches: vec![TrackedBranch {
                branch_id: 0,
                label: Some("B0".to_string()),
                points: vec![TrackedBranchPoint {
                    sample_index: 0,
                    raw_mode_index: 0,
                    frequency_real_hz: 1.0e9,
                    frequency_imag_hz: 0.0,
                    tracking_confidence: 1.0,
                    overlap_prev: None,
                }],
            }],
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: vec!["single sample".to_string()],
        }
    }

    #[test]
    fn eigen_artifact_writer_emits_v2_contract_files() {
        let temp = TempDirGuard::new("eigen-artifacts-v2");
        let result = sample_result();

        write_path_bundle(&temp.path, &result).expect("path bundle should write");
        write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
        write_mode_bundle(&temp.path, &result).expect("mode bundle should write");

        let eigen_dir = temp.path.join("eigen");
        let spectrum: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("spectrum.v2.json"))
                .expect("spectrum.v2.json should be written"),
        )
        .expect("spectrum.v2.json should be valid JSON");
        assert_eq!(spectrum["schema_version"], "eigen_spectrum.v2");
        assert_eq!(spectrum["sample_count"], 1);

        let branches: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("branches.v2.json"))
                .expect("branches.v2.json should be written"),
        )
        .expect("branches.v2.json should be valid JSON");
        assert_eq!(branches["schema_version"], "eigen_branches.v2");

        let dispersion = std::fs::read_to_string(eigen_dir.join("dispersion.csv"))
            .expect("dispersion.csv should be written");
        let mut dispersion_lines = dispersion.lines();
        assert_eq!(
            dispersion_lines.next(),
            Some("sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score")
        );
        let dispersion_row = dispersion_lines
            .next()
            .expect("dispersion.csv should include a mode row");
        assert!(
            dispersion_row
                .split(',')
                .nth(11)
                .is_some_and(|value| !value.is_empty()),
            "dispersion.csv residual_norm column should be populated, row={dispersion_row}"
        );

        let mode: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("modes/sample_0000_mode_0000.json"))
                .expect("flat v2 mode artifact should be written"),
        )
        .expect("mode artifact should be valid JSON");
        assert_eq!(mode["sample_index"], 0);
        assert_eq!(mode["raw_mode_index"], 0);
        for required in [
            "residual_norm",
            "residual_linf",
            "tangent_leakage_mean_abs",
            "tangent_leakage_max_abs",
        ] {
            assert!(
                mode[required].as_f64().is_some(),
                "mode artifact should include numeric {required}: {mode}"
            );
        }

        assert!(eigen_dir.join("path.json").is_file());
        assert!(eigen_dir.join("branches.json").is_file());
        assert!(eigen_dir.join("branch_table.csv").is_file());
        assert!(eigen_dir.join("modes/sample_0000/mode_0000.json").is_file());
    }

    #[test]
    fn response_artifact_writer_emits_v1_contract_file() {
        let temp = TempDirGuard::new("response-artifact-v1");
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
        let sweep = solve_field_driven_block_real_sweep(&template, &[2.0], &field_excitation)
            .expect("field-driven sweep should solve");
        let artifact = build_field_driven_response_sweep_artifact(
            &sweep,
            "runner.dense_block_real",
            "dense_block_real_lu",
            "gilbert_linear",
            "local_validation",
        );

        write_response_sweep_artifact(&temp.path, &artifact)
            .expect("response sweep artifact should write");

        let artifact_path = temp.path.join("response/magnetic_response_sweep.v1.json");
        let value: Value = serde_json::from_slice(
            &std::fs::read(&artifact_path).expect("response artifact should be written"),
        )
        .expect("response artifact should be valid JSON");

        assert_eq!(value["schema_version"], "magnetic_response_sweep.v1");
        assert_eq!(value["backend_engine_id"], "runner.dense_block_real");
        assert_eq!(value["point_count"], 1);
        assert_eq!(value["si_units"]["frequency_hz"], "Hz");
        assert_eq!(value["points"][0]["angular_frequency_rad_per_s"], 2.0);
        assert_eq!(
            value["points"][0]["m_complex"][0],
            serde_json::json!([0.0, -1.0])
        );
        assert_eq!(
            value["points"][0]["response_phase"][0],
            -std::f64::consts::FRAC_PI_2
        );
        assert_eq!(
            value["points"][0]["tangent_leakage"]["kind"],
            "not_evaluated_dense_validation",
        );
        assert_eq!(value["points"][0]["excitation_provenance"]["kind"], "field");
    }
}
