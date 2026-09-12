use super::common::*;
use super::field_sweep::*;
use super::fmr::*;
use super::kittel::*;
use super::modal_manifest::*;
use super::mode_bundle::*;
use super::*;
use crate::eigen::response_block_real::{
    build_field_driven_response_sweep_artifact, solve_field_driven_block_real_sweep,
    solve_field_driven_block_real_sweep_with_interrupt, BlockRealHarmonicTemplate,
};
use crate::eigen::types::{
    EigenSolverModel, K0KittelPeriodicAirboxDemagMetrics, KSampleDescriptor, PathSolveResult,
    SingleKModeResult, SingleKSolveResult, TrackedBranch, TrackedBranchPoint,
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
        let path =
            std::env::temp_dir().join(format!("fullmag-runner-{slug}-{}", uuid::Uuid::new_v4()));
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
    sample_result_with_solver_model(EigenSolverModel::ReferenceScalarTangent)
}

fn sample_result_with_solver_model(solver_model: EigenSolverModel) -> PathSolveResult {
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
                mass_norm: Some(7.25),
                max_amplitude: 1.0,
                residual_norm: Some(1.25e-9),
                residual_linf: Some(2.5e-10),
                tangent_leakage_mean_abs: Some(3.0e-12),
                tangent_leakage_max_abs: Some(4.0e-12),
                tangent_leakage_weighted_relative_l2: Some(3.5e-12),
                dominant_polarization: "linear".to_string(),
                reduced_vector: Some(vec![Complex64::new(1.0, 0.0)]),
                lifted_real: Some(vec![[1.0, 0.0, 0.0]]),
                lifted_imag: Some(vec![[0.0, 1.0, 0.0]]),
                amplitude: Some(vec![1.0]),
                phase: Some(vec![0.0]),
                node_mass_weights: None,
                component_participation:
                    crate::eigen::ModalParticipationObservable::unavailable_without_context("cpu"),
            }],
            relaxation_steps: 0,
            solver_model,
            solver_notes: vec!["test fixture".to_string()],
            solver_diagnostics: Some(serde_json::json!({
                "mesh_id": "mesh:test",
                "mesh_generation_id": "mesh-generation:test",
                "mesh_revision": 17,
                "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            })),
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
        solver_model,
        notes: vec!["single sample".to_string()],
        include_demag: false,
        dispersion_validation: None,
        k0_kittel_validation: None,
        dispersion_analytic_reference: None,
        k0_kittel_periodic_airbox_demag: None,
    }
}

#[test]
fn single_sample_mode_provenance_prefers_enriched_root_diagnostics() {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "relax_to_eigen_handoff_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sample_solver_diagnostics": [{
            "sample_index": 0,
            "diagnostics": {"status": "ready"},
        }],
    }));

    let summary = summarize_mode(
        &result.samples[0],
        &result.samples[0].modes[0],
        result.solver_model,
    );

    assert_eq!(
        summary.relax_to_eigen_handoff_sha256.as_deref(),
        Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
}

fn sample_result_with_modal_overlap_tracking() -> PathSolveResult {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    let mut sample_1 = result.samples[0].clone();
    sample_1.sample.sample_index = 1;
    sample_1.sample.label = Some("X".to_string());
    sample_1.sample.path_s = 10_000_000.0;
    sample_1.sample.k_vector = [10_000_000.0, 0.0, 0.0];
    sample_1.modes[0].frequency_real_hz = 1.25e9;
    sample_1.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * 1.25e9;
    sample_1.modes[0].eigenvalue_imag = std::f64::consts::TAU * 1.25e9;
    let mut sample_2 = sample_1.clone();
    sample_2.sample.sample_index = 2;
    sample_2.sample.label = Some("G".to_string());
    sample_2.sample.path_s = 20_000_000.0;
    sample_2.sample.k_vector = [0.0, 0.0, 0.0];
    sample_2.modes[0].frequency_real_hz = 1.5e9;
    sample_2.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * 1.5e9;
    sample_2.modes[0].eigenvalue_imag = std::f64::consts::TAU * 1.5e9;
    result.samples.push(sample_1);
    result.samples.push(sample_2);
    result.branches[0].points.push(TrackedBranchPoint {
        sample_index: 1,
        raw_mode_index: 0,
        frequency_real_hz: 1.25e9,
        frequency_imag_hz: 0.0,
        tracking_confidence: 0.8,
        overlap_prev: Some(0.8),
    });
    result.branches[0].points.push(TrackedBranchPoint {
        sample_index: 2,
        raw_mode_index: 0,
        frequency_real_hz: 1.5e9,
        frequency_imag_hz: 0.0,
        tracking_confidence: 0.6,
        overlap_prev: Some(0.6),
    });
    result.notes = vec!["modal overlap tracking".to_string()];
    result
}

fn sample_result_with_k0_kittel_sweep() -> PathSolveResult {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    let template = result.samples[0].clone();
    let fields_a_per_m = [40_000.0, 80_000.0, 120_000.0];

    result.samples.clear();
    result.branches = vec![TrackedBranch {
        branch_id: 0,
        label: Some("k0_kittel_uniform_branch".to_string()),
        points: Vec::new(),
    }];

    for (sample_index, field_a_per_m) in fields_a_per_m.iter().copied().enumerate() {
        let frequency_hz =
            REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M * field_a_per_m / std::f64::consts::TAU;
        let mut sample = template.clone();
        sample.sample.sample_index = sample_index;
        sample.sample.label = Some(format!("H{sample_index}"));
        sample.sample.path_s = sample_index as f64;
        sample.sample.t_in_segment = sample_index as f64 / (fields_a_per_m.len() - 1) as f64;
        sample.sample.k_vector = [0.0, 0.0, 0.0];
        sample.modes[0].frequency_real_hz = frequency_hz;
        sample.modes[0].frequency_imag_hz = 0.0;
        sample.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * frequency_hz;
        sample.modes[0].eigenvalue_real = 0.0;
        sample.modes[0].eigenvalue_imag = std::f64::consts::TAU * frequency_hz;
        result.samples.push(sample);
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 0,
            frequency_real_hz: frequency_hz,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
        });
    }

    result.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: None,
        demag_kind: None,
        model: "macrospin_larmor".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: None,
        },
        samples: fields_a_per_m
            .iter()
            .copied()
            .enumerate()
            .map(
                |(sample_index, field_a_per_m)| fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: sample_index as u32,
                    bias_field: [field_a_per_m, 0.0, 0.0],
                },
            )
            .collect(),
    });
    result.notes = vec!["k0 Kittel field sweep".to_string()];
    result
}

#[test]
fn eigen_artifact_writer_emits_v2_contract_files() {
    let temp = TempDirGuard::new("eigen-artifacts-v2");
    let result = sample_result();

    write_path_bundle(&temp.path, &result).expect("path bundle should write");
    write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
    write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
    write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let eigen_dir = temp.path.join("eigen");
    let spectrum: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("spectrum.v2.json"))
            .expect("spectrum.v2.json should be written"),
    )
    .expect("spectrum.v2.json should be valid JSON");
    assert_eq!(spectrum["schema_version"], "eigen_spectrum.v2");
    assert_eq!(spectrum["sample_count"], 1);
    assert_eq!(
        spectrum["samples"][0]["sample_id"],
        "bias-field-sample-0000"
    );
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["mode_id"],
        "sample-0000/mode-0000"
    );
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["mode_field_id"],
        "analysis:eigen:sample-0000:mode-0000"
    );
    assert_eq!(
            spectrum["samples"][0]["modes"][0]["mode_field_resource_key"],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        );
    assert!(spectrum["samples"][0]["modes"][0]
        .get("component_participation")
        .is_none());

    let spectrum_v3: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("spectrum.v3.json"))
            .expect("spectrum.v3.json should be written"),
    )
    .expect("spectrum.v3.json should be valid JSON");
    assert_eq!(spectrum_v3["schema_version"], "eigen_spectrum.v3");
    assert_eq!(
        spectrum_v3["samples"][0]["modes"][0]["component_participation"]["definition_id"],
        crate::eigen::MODAL_PARTICIPATION_DEFINITION_ID
    );

    let branches: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("branches.v2.json"))
            .expect("branches.v2.json should be written"),
    )
    .expect("branches.v2.json should be valid JSON");
    assert_eq!(branches["schema_version"], "eigen_branches.v2");
    assert_eq!(branches["tracking_score_source"], "seed_only");
    assert_eq!(branches["modal_overlap_available"], false);
    assert_eq!(
        branches["diagnostics"]["tracking_score_source"],
        "seed_only"
    );
    assert_eq!(branches["diagnostics"]["modal_overlap_available"], false);
    assert_eq!(
        branches["branches"][0]["points"][0]["tracking_score_source"],
        "seed"
    );
    assert_eq!(
        branches["branches"][0]["points"][0]["modal_overlap_available"],
        false
    );
    assert_eq!(
        branches["branches"][0]["points"][0]["mode_field_id"],
        "analysis:eigen:sample-0000:mode-0000"
    );
    assert_eq!(
            branches["branches"][0]["points"][0]["mode_field_resource_key"],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        );

    let dispersion = std::fs::read_to_string(eigen_dir.join("dispersion.csv"))
        .expect("dispersion.csv should be written");
    let mut dispersion_lines = dispersion.lines();
    let dispersion_header = dispersion_lines
        .next()
        .expect("dispersion.csv should include a header");
    assert_eq!(
            Some(dispersion_header),
            Some(
                "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key"
            )
        );
    let dispersion_row = dispersion_lines
        .next()
        .expect("dispersion.csv should include a mode row");
    let dispersion_columns = dispersion_row.split(',').collect::<Vec<_>>();
    let header_columns = dispersion_header.split(',').collect::<Vec<_>>();
    let column = |name: &str| {
        header_columns
            .iter()
            .position(|column| *column == name)
            .expect("dispersion column should exist")
    };
    assert!(
        dispersion_columns
            .get(column("residual_norm"))
            .is_some_and(|value| !value.is_empty()),
        "dispersion.csv residual_norm column should be populated, row={dispersion_row}"
    );
    assert_eq!(
        dispersion_columns.get(column("tracking_score_source")),
        Some(&"seed")
    );
    assert_eq!(
        dispersion_columns.get(column("mode_field_id")),
        Some(&"analysis:eigen:sample-0000:mode-0000")
    );
    assert_eq!(
            dispersion_columns.get(column("mode_field_resource_key")),
            Some(&"/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0")
        );

    let mode: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("modes/sample_0000_mode_0000.json"))
            .expect("flat v2 mode artifact should be written"),
    )
    .expect("mode artifact should be valid JSON");
    assert_eq!(mode["sample_index"], 0);
    assert_eq!(mode["raw_mode_index"], 0);
    assert_eq!(mode["frequency_hz"], 1.0e9);
    assert_eq!(mode["frequency_real_hz"], 1.0e9);
    assert_eq!(
        mode["mode_field_id"],
        "analysis:eigen:sample-0000:mode-0000"
    );
    assert_eq!(
            mode["mode_field_resource_key"],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        );
    for required in [
        "residual_norm",
        "residual_linf",
        "tangent_leakage_mean_abs",
        "tangent_leakage_max_abs",
        "tangent_leakage_weighted_relative_l2",
    ] {
        assert!(
            mode[required].as_f64().is_some(),
            "mode artifact should include numeric {required}: {mode}"
        );
    }
    assert_eq!(mode["mode_field_sample_count"], 1);
    assert_eq!(mode["amplitude_summary"]["sample_count"], 1);
    assert_eq!(mode["amplitude_summary"]["max"], 1.0);
    assert_eq!(mode["mass_norm"], 7.25);
    assert_eq!(mode["component_summary"]["real_sample_count"], 1);
    assert_eq!(mode["component_summary"]["imag_sample_count"], 1);
    assert_eq!(mode["value_kind"], "complex_spatial_vector");
    assert_eq!(mode["component_basis"], "global_xyz");
    assert_eq!(mode["component_count"], 3);
    assert_eq!(mode["components"], serde_json::json!(["x", "y", "z"]));
    assert_eq!(mode["payload_encoding"], "f64_interleaved_real_imag_xyz");
    assert_eq!(mode["binary_layout"], "complex_f64_pairs_little_endian");
    assert_eq!(mode["complex_pair_count"], 3);
    assert_eq!(mode["payload_value_count"], 6);
    assert_eq!(
        mode["available_views"],
        serde_json::json!([
            "complex",
            "real",
            "imag",
            "abs",
            "amplitude",
            "phase",
            "phase_rotated_real"
        ])
    );
    assert_eq!(mode["default_view"], "phase_rotated_real");
    assert_eq!(mode["default_phase_rad"], 0.0);
    assert!(
        mode.get("real").is_none()
            && mode.get("imag").is_none()
            && mode.get("amplitude").is_none()
            && mode.get("phase").is_none(),
        "mode metadata must not inline vector arrays: {mode}"
    );

    assert!(eigen_dir.join("path.json").is_file());
    assert!(eigen_dir.join("branches.json").is_file());
    assert!(eigen_dir.join("branch_table.csv").is_file());
    assert!(eigen_dir.join("modes/sample_0000/mode_0000.json").is_file());
    let nested_mode: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("modes/sample_0000/mode_0000.json"))
            .expect("nested mode artifact should be written"),
    )
    .expect("nested mode artifact should be valid JSON");
    assert_eq!(nested_mode["mode_field_id"], mode["mode_field_id"]);
    assert_eq!(nested_mode["mass_norm"], mode["mass_norm"]);
    assert_eq!(
        nested_mode["mode_field_resource_key"],
        mode["mode_field_resource_key"]
    );
    let mode_field = std::fs::read(eigen_dir.join("mode_fields/sample_0000/mode_0000/vector.bin"))
        .expect("mode vector payload should be written");
    assert_eq!(mode_field.len(), 3 * 2 * std::mem::size_of::<f64>());

    let family_manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain eigen manifest should be written"),
    )
    .expect("frequency-domain eigen manifest should be valid JSON");
    assert_eq!(
        family_manifest["schema_version"],
        "frequency_domain_manifest.v1"
    );
    assert_eq!(
        family_manifest["analysis_family"],
        "magnetic_frequency_domain"
    );
    assert_eq!(family_manifest["study_product"], "modal_eigen");
    assert_eq!(family_manifest["stage_kind"], "eigenmodes");
    assert_eq!(
        family_manifest["requested_execution"]["calculation_mode"],
        "free_modes"
    );
    assert_eq!(
        family_manifest["physics"]["analysis_family"],
        "magnetic_frequency_domain"
    );
    assert_eq!(
        family_manifest["physics"]["phase_convention"],
        "exp_minus_i_omega_t"
    );
    assert_eq!(family_manifest["physics"]["frequency_units"], "Hz");
    assert_eq!(
        family_manifest["physics"]["field_units"],
        "dimensionless_delta_m"
    );
    assert_eq!(family_manifest["physics"]["normalization"], "unit_l2");
    assert_eq!(
        family_manifest["artifacts"]["spectrum_v2_path"],
        "eigen/spectrum.v2.json"
    );
    assert_eq!(
        family_manifest["artifacts"]["solver_diagnostics_path"],
        "eigen/diagnostics/solver.v1.json"
    );
    assert!(temp.path.join("eigen/diagnostics/solver.v1.json").is_file());
    assert_eq!(
        family_manifest["artifacts"]["mode_metadata_paths"][0],
        "eigen/modes/sample_0000/mode_0000.json"
    );
    assert_eq!(
        family_manifest["resources"]["mode_field_resources"][0],
        "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/0/meta"
    );
    assert_eq!(
        family_manifest["diagnostics"]["tracking_score_source"],
        "seed_only"
    );
    assert_eq!(
        family_manifest["diagnostics"]["modal_overlap_available"],
        false
    );
    assert_eq!(
        family_manifest["capabilities"]["modal_artifact_available"],
        true
    );
}

#[test]
fn eigen_manifest_does_not_publish_dispersion_for_single_free_modes() {
    let temp = TempDirGuard::new("eigen-manifest-free-modes");
    let result = sample_result();

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain eigen manifest should be written"),
    )
    .expect("frequency-domain eigen manifest should be valid JSON");
    assert_eq!(
        manifest["requested_execution"]["calculation_mode"],
        "free_modes"
    );
    assert_eq!(
        manifest["requested_execution"]["outputs"],
        serde_json::json!(["spectrum", "mode_fields"])
    );
    assert!(manifest["artifacts"]["branches_v2_path"].is_null());
    assert!(manifest["artifacts"]["dispersion_csv_path"].is_null());
    assert!(manifest["resources"]["branches_resource_key"].is_null());
    assert!(manifest["resources"]["dispersion_resource_key"].is_null());
}

#[test]
fn eigen_manifest_preserves_real_planner_resolution_for_all_exact_k0_lanes() {
    let cases = [
        (
            "cpu",
            None,
            "cpu",
            "k0_poisson_airbox_cpu_schur_slepc",
            "production_cpu",
            false,
            None,
        ),
        (
            "gpu",
            None,
            "gpu",
            "gpu_modal_device_krylov",
            "production_gpu",
            false,
            None,
        ),
        (
            "auto",
            Some(serde_json::json!({
                "device": "cpu",
                "source": "managed_launcher",
                "fallback_reason": "gpu_modal_device_krylov_unavailable",
            })),
            "cpu",
            "k0_poisson_airbox_cpu_schur_slepc",
            "production_cpu",
            true,
            Some("gpu_modal_device_krylov_unavailable"),
        ),
    ];

    for (
        requested_device,
        runtime_override,
        resolved_device,
        resolved_engine,
        native_target,
        planner_fallback_used,
        planner_fallback_reason,
    ) in cases
    {
        let problem = crate::fem::real_bounded_k0_problem(requested_device, runtime_override);
        let plan = fullmag_plan::plan(&problem).expect("real bounded K0 ProblemIR must plan");
        let fem = match &plan.backend_plan {
            fullmag_ir::BackendPlanIR::FemEigen(fem) => fem,
            other => panic!("expected real FEM eigen plan, got {other:?}"),
        };
        let execution = crate::fem_eigen::resolve_planned_fem_eigen_execution(&plan, fem)
            .expect("real exact K0 resolution must validate")
            .expect("real exact K0 plan must carry a resolution");
        let resolution = execution
            .resolution()
            .expect("exact execution must expose its accepted resolution")
            .clone();
        let resolved_target = if resolved_device == "gpu" { 2 } else { 1 };
        let native_attestation =
            execution.native_attestation(Some(resolved_target), resolved_engine, 0, "none");
        let mut result = sample_result_with_solver_model(if resolved_device == "gpu" {
            EigenSolverModel::ProductionGpuModalDeviceKrylov
        } else {
            EigenSolverModel::ProductionCpuShiftInvert
        });
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "requested_execution": {
                "device": resolution.requested_device,
                "precision": resolution.requested_precision,
                "engine": resolution.requested_engine,
            },
            "resolved_execution": {
                "device": resolution.resolved_device,
                "precision": resolution.resolved_precision,
                "engine": resolution.resolved_engine,
                "fallback_used": resolution.fallback_used,
                "fallback_reason": resolution.fallback_reason,
                "fallback_from_engine": resolution.requested_engine,
                "fallback_to_engine": resolution.resolved_engine,
            },
            "fem_eigen_execution_resolution": resolution,
            "native_execution_attestation": native_attestation,
        }));

        let temp = TempDirGuard::new(&format!(
            "eigen-manifest-real-exact-execution-{requested_device}"
        ));
        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain eigen manifest should be written"),
        )
        .expect("frequency-domain eigen manifest should be valid JSON");

        assert_eq!(
            manifest["fem_eigen_execution_resolution"]["requested_device"],
            requested_device
        );
        assert_eq!(
            manifest["fem_eigen_execution_resolution"]["resolved_device"],
            resolved_device
        );
        assert_eq!(
            manifest["fem_eigen_execution_resolution"]["resolved_engine"],
            resolved_engine
        );
        assert_eq!(
            manifest["resolved_execution"]["fallback_used"],
            planner_fallback_used
        );
        if let Some(reason) = planner_fallback_reason {
            assert_eq!(manifest["resolved_execution"]["fallback_reason"], reason);
        } else {
            assert!(manifest["resolved_execution"]["fallback_reason"].is_null());
        }
        assert_eq!(
            manifest["native_execution_attestation"]["requested_target"],
            native_target
        );
        assert_eq!(
            manifest["native_execution_attestation"]["resolved_target"],
            native_target
        );
        assert_eq!(
            manifest["native_execution_attestation"]["resolved_engine_id"],
            resolved_engine
        );
        assert_eq!(
            manifest["native_execution_attestation"]["fallback_used"],
            false
        );
        assert!(manifest["native_execution_attestation"]
            .get("fallback_reason")
            .is_none());
    }
}

#[test]
fn eigen_manifest_does_not_publish_dispersion_for_multi_sample_k0_field_sweep() {
    let temp = TempDirGuard::new("eigen-manifest-k0-field-sweep");
    let result = sample_result_with_k0_kittel_sweep();

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain eigen manifest should be written"),
    )
    .expect("frequency-domain eigen manifest should be valid JSON");
    assert_eq!(
        manifest["requested_execution"]["calculation_mode"],
        "free_modes"
    );
    assert_eq!(manifest["requested_execution"]["k_sampling"], "single");
    assert_eq!(
        manifest["requested_execution"]["outputs"],
        serde_json::json!(["spectrum", "mode_fields"])
    );
    assert!(manifest["artifacts"]["branches_v2_path"].is_null());
    assert!(manifest["artifacts"]["dispersion_csv_path"].is_null());
    assert!(manifest["resources"]["branches_resource_key"].is_null());
    assert!(manifest["resources"]["dispersion_resource_key"].is_null());
    assert_eq!(
        manifest["validation"]["k0_kittel_validation"]["kind"],
        "k0_kittel_field_sweep"
    );
}

#[test]
fn eigen_branch_writer_reports_modal_overlap_statistics() {
    let temp = TempDirGuard::new("eigen-branch-overlap-stats");
    let result = sample_result_with_modal_overlap_tracking();

    write_branch_bundle(&temp.path, &result).expect("branch bundle should write");

    let branches: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/branches.v2.json"))
            .expect("branches.v2.json should be written"),
    )
    .expect("branches.v2.json should be valid JSON");
    assert_eq!(
        branches["diagnostics"]["tracking_score_source"],
        "modal_overlap_weighted_score"
    );
    assert_eq!(branches["diagnostics"]["modal_overlap_available"], true);
    assert_eq!(branches["diagnostics"]["min_overlap"], 0.6);
    assert_eq!(branches["diagnostics"]["median_overlap"], 0.7);
}

#[test]
fn eigen_manifest_marks_production_cpu_shift_invert_as_native_production() {
    let temp = TempDirGuard::new("eigen-artifacts-production-manifest");
    let result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let family_manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain eigen manifest should be written"),
    )
    .expect("frequency-domain eigen manifest should be valid JSON");

    assert_eq!(
        family_manifest["resolved_execution"]["engine"],
        "multi_k_orchestrator/slepc_multi_shift_invert_production_cpu_dense"
    );
    assert_eq!(
        family_manifest["resolved_execution"]["native_backend"],
        "native_cpu"
    );
    assert_eq!(
        family_manifest["resolved_execution"]["reference_or_production"],
        "production"
    );
    assert_eq!(
        family_manifest["resolved_execution"]["solver_library"],
        "slepc"
    );
    assert_eq!(
        family_manifest["capabilities"]["production_native_solver_available"],
        true
    );
    assert_eq!(
        family_manifest["capabilities"]["validation_artifact"],
        false
    );
}

#[test]
fn eigen_manifest_preserves_native_gpu_execution_and_hardened_provenance() {
    let temp = TempDirGuard::new("eigen-artifacts-native-gpu-provenance");
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.include_demag = true;
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "sample_solver_diagnostics": [{
            "diagnostics": {
                "physics_contract_version": "micromagnetics_frequency_domain_v5",
                "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
                "implementation_state": "executable",
                "validation_state": "unvalidated",
                "validated_scope": "fem_k0_periodic_airbox_p1_double_gpu_device_krylov",
                "assembly_kind": "mfem_weak_form_shared_domain",
                "operator_input_signature_sha256": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "production_solver_available": true,
                "validation_only": false,
                "boundary_gauge": {
                    "magnetostatic_bc": "periodic_airbox_k0",
                    "outer_boundary_kind": "poisson_robin",
                    "robin_beta": 8.0e6,
                    "robin_beta_unit": "1/m",
                    "gauge_policy": "none",
                    "gauge_reason": "coercive_outer_boundary",
                    "eta_row_present": false
                },
                "spectral": {
                    "spectral_transform": "shift_invert",
                    "spectral_scalar_mode": "real_split",
                    "sigma_real_per_s": 0.0,
                    "sigma_imag_rad_per_s": 1.0e10
                },
                "phase_constraint_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "equilibrium_artifact_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "linearization_state_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "periodic_mesh_certificate_sha256": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "phasor_convention": "exp_plus_i_omega_t",
                "requested_execution": {
                    "device": "gpu",
                    "precision": "double",
                    "execution_mode": "strict",
                    "solver_method": "shift_invert",
                    "preconditioner": "shifted_schur_device",
                    "magnetostatic_bc": "periodic_airbox_k0"
                },
                "resolved_execution": {
                    "device": "gpu",
                    "precision": "double",
                    "engine": "gpu_petsc_slepc_cuda",
                    "implementation_id": "k0_poisson_airbox_gpu_petsc_slepc",
                    "status": "ok",
                    "operator_residency": "device",
                    "vector_residency": "device",
                    "krylov_residency": "device",
                    "preconditioner_residency": "device",
                    "solver_library": "SLEPc/PETSc/hypre CUDA",
                    "fallback_used": false,
                    "fallback_reason": null
                }
            }
        }]
    }));

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain manifest should write");
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain manifest should be written"),
    )
    .expect("frequency-domain manifest should parse");

    assert_eq!(manifest["requested_execution"]["device"], "gpu");
    assert_eq!(manifest["requested_execution"]["execution_mode"], "strict");
    assert_eq!(
        manifest["requested_execution"]["preconditioner"],
        "shifted_schur_device"
    );
    assert_eq!(manifest["resolved_execution"]["device"], "gpu");
    assert_eq!(
        manifest["resolved_execution"]["engine"],
        "gpu_petsc_slepc_cuda"
    );
    assert_eq!(
        manifest["resolved_execution"]["implementation_id"],
        "k0_poisson_airbox_gpu_petsc_slepc"
    );
    assert_eq!(manifest["resolved_execution"]["krylov_residency"], "device");
    assert_eq!(
        manifest["capabilities"]["production_native_solver_available"],
        true
    );
    assert_eq!(manifest["capabilities"]["validation_artifact"], false);
    assert_eq!(manifest["assembly_kind"], "mfem_weak_form_shared_domain");
    assert_eq!(
        manifest["operator_input_signature_sha256"],
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    );
    assert_eq!(
        manifest["boundary_gauge"]["outer_boundary_kind"],
        "poisson_robin"
    );
    assert_eq!(manifest["spectral"]["spectral_scalar_mode"], "real_split");
    assert_eq!(
        manifest["phase_constraint_sha256"],
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
}

#[test]
fn eigen_artifacts_write_k0_kittel_summary_and_points() {
    let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-summary");
    let result = sample_result_with_k0_kittel_sweep();

    write_path_bundle(&temp.path, &result).expect("path bundle should write");
    write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
    write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let validation_dir = temp.path.join("validation/kittel_k0_pbc");
    let summary: Value = serde_json::from_slice(
        &std::fs::read(validation_dir.join("summary.v1.json"))
            .expect("Kittel k0 summary should be written"),
    )
    .expect("Kittel k0 summary should be valid JSON");
    assert_eq!(
        summary["schema_version"],
        "frequency_domain_kittel_k0_validation.v1"
    );
    assert_eq!(summary["status"], "passed");
    assert_eq!(summary["model"], "macrospin_larmor");
    assert_eq!(summary["sweep_point_count"], 3);
    assert!(
        summary["max_relative_frequency_error"]
            .as_f64()
            .expect("max relative error should be numeric")
            <= 0.05
    );

    let points_csv = std::fs::read_to_string(validation_dir.join("points.v1.csv"))
        .expect("Kittel k0 points CSV should be written");
    let rows = points_csv.lines().collect::<Vec<_>>();
    assert_eq!(rows.len(), 4);
    assert!(rows[0].starts_with("case_id,demag_kind,field_index,H0_A_per_m,mu0_H0_T"));
    assert!(rows[0].contains("relative_frequency_error"));

    let kittel_fit: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("fmr/kittel_fit.v1.json"))
            .expect("typed Kittel fit artifact should be written"),
    )
    .expect("typed Kittel fit artifact should be valid JSON");
    assert_eq!(kittel_fit["schema_version"], "fmr/kittel_fit.v1");
    assert_eq!(kittel_fit["source"]["artifact"], "eigen/spectrum.v2.json");
    assert_eq!(kittel_fit["model"], "macrospin_larmor");
    assert_eq!(kittel_fit["complete"], false);
}

#[test]
fn k0_kittel_summary_prefers_native_lane_when_path_model_is_reference() {
    let mut result = sample_result_with_k0_kittel_sweep();
    result.solver_model = EigenSolverModel::ReferenceFull2x2Tangent;
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "execution_lane": "production_gpu",
        "resolved_execution": {
            "reference_or_production": "production",
            "solver_algorithm": "k0_poisson_airbox_gpu_petsc_slepc"
        },
        "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc"
    }));

    let artifacts = k0_kittel_validation_auxiliary_artifacts(&result)
        .expect("Kittel summary should be emitted for the diagnostic fixture");
    let summary_artifact = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/summary.v1.json")
        .expect("Kittel summary should be present");
    let summary: Value =
        serde_json::from_slice(&summary_artifact.bytes).expect("summary should be valid JSON");
    assert_eq!(summary["solver"]["execution_lane"], "production_gpu");
    assert_eq!(
        summary["solver"]["solver_algorithm"],
        "k0_poisson_airbox_gpu_petsc_slepc"
    );
}

#[test]
fn mode_bundle_preserves_k0_operator_provenance() {
    let temp = TempDirGuard::new("eigen-artifacts-mode-provenance");
    let mut result = sample_result_with_k0_kittel_sweep();
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "mesh_id": "mesh:test",
        "assembly_kind": "mfem_weak_form_shared_domain",
        "operator_input_signature_sha256": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "phase_constraint_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "equilibrium_artifact_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "linearization_state_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "relax_to_eigen_handoff_sha256": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "source_mesh_topology_sha256": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        "periodic_mesh_certificate_sha256": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    }));

    write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
    let mode: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/modes/sample_0000/mode_0000.json"))
            .expect("mode metadata should be written"),
    )
    .expect("mode metadata should parse");

    assert_eq!(
        mode["external_field_a_per_m"],
        serde_json::json!([40_000.0, 0.0, 0.0])
    );
    assert_eq!(mode["assembly_kind"], "mfem_weak_form_shared_domain");
    assert_eq!(
        mode["operator_input_signature_sha256"],
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    );
    assert_eq!(
        mode["linearization_state_sha256"],
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );
    assert_eq!(
        mode["relax_to_eigen_handoff_sha256"],
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    );
    assert_eq!(
        mode["source_mesh_topology_sha256"],
        "sha256:9999999999999999999999999999999999999999999999999999999999999999"
    );
}

#[test]
fn mode_bundle_binds_field_payload_to_immutable_source_mesh_identity() {
    let temp = TempDirGuard::new("eigen-artifacts-mode-source-mesh");
    let mut result = sample_result();
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "mesh_id": "mesh:test",
        "mesh_generation_id": "mesh-generation:test",
        "mesh_revision": 17,
        "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));

    write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
    let mode: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/modes/sample_0000/mode_0000.json"))
            .expect("mode metadata should be written"),
    )
    .expect("mode metadata should parse");

    assert_eq!(
        mode["source_mesh_identity"],
        serde_json::json!({
            "mesh_id": "mesh:test",
            "mesh_generation_id": "mesh-generation:test",
            "mesh_revision": 17,
            "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "indexing": "full_domain_node_order",
            "node_count": 1,
        })
    );
}

#[test]
fn mode_bundle_rejects_invalid_source_mesh_identity_before_publication() {
    for (slug, diagnostics) in [
        ("missing", serde_json::json!({})),
        (
            "missing-mesh-id",
            serde_json::json!({
                "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            }),
        ),
        (
            "noncanonical-topology",
            serde_json::json!({
                "mesh_id": "mesh:test",
                "topology_fingerprint": "mesh-rev:1",
            }),
        ),
    ] {
        let temp = TempDirGuard::new(&format!("eigen-artifacts-mode-source-mesh-{slug}"));
        let mut result = sample_result();
        result.samples[0].solver_diagnostics = Some(diagnostics);

        let error = write_mode_bundle(&temp.path, &result)
            .expect_err("invalid source mesh identity must block mode-field publication");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("source mesh identity"));
        assert!(!temp.path.join("eigen/modes").exists());
        assert!(!temp.path.join("eigen/mode_fields").exists());
    }
}

#[test]
fn k0_kittel_artifacts_reject_periodic_airbox_without_real_metrics() {
    let mut result = sample_result_with_k0_kittel_sweep();
    let validation = result
        .k0_kittel_validation
        .as_mut()
        .expect("fixture should carry K0 Kittel validation");
    validation.case_id = Some("K0-3".to_string());
    validation.demag_kind = Some("periodic_airbox_k0".to_string());
    validation.model = "thin_film_in_plane".to_string();
    validation.material.effective_magnetisation = Some(800_000.0);

    let err = k0_kittel_validation_auxiliary_artifacts(&result)
        .expect_err("periodic_airbox_k0 must require real PA-E4b metrics");

    assert!(
        err.to_string().contains("PA-E4b")
            && err.to_string().contains("production periodic-airbox")
    );
}

#[test]
fn k0_kittel_artifacts_accept_periodic_airbox_with_real_metrics() {
    let mut result = sample_result_with_k0_kittel_sweep();
    let effective_magnetisation = 800_000.0;
    let fields_a_per_m = [40_000.0, 80_000.0, 120_000.0];
    let validation = result
        .k0_kittel_validation
        .as_mut()
        .expect("fixture should carry K0 Kittel validation");
    validation.case_id = Some("K0-3".to_string());
    validation.demag_kind = Some("periodic_airbox_k0".to_string());
    validation.model = "thin_film_in_plane".to_string();
    validation.relative_tolerance = 0.02;
    validation.material.effective_magnetisation = Some(effective_magnetisation);

    for ((sample, branch_point), field_a_per_m) in result
        .samples
        .iter_mut()
        .zip(
            result
                .branches
                .get_mut(0)
                .expect("fixture should have a tracked branch")
                .points
                .iter_mut(),
        )
        .zip(fields_a_per_m)
    {
        let frequency_hz = REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M
            * (field_a_per_m * (field_a_per_m + effective_magnetisation)).sqrt()
            / std::f64::consts::TAU;
        sample.modes[0].frequency_real_hz = frequency_hz;
        sample.modes[0].frequency_imag_hz = 0.0;
        sample.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * frequency_hz;
        sample.modes[0].eigenvalue_real = 0.0;
        sample.modes[0].eigenvalue_imag = std::f64::consts::TAU * frequency_hz;
        branch_point.frequency_real_hz = frequency_hz;
        branch_point.frequency_imag_hz = 0.0;
    }
    result.k0_kittel_periodic_airbox_demag = Some(K0KittelPeriodicAirboxDemagMetrics {
        mesh_resolution_m: 5.0e-9,
        airbox_size_m: 80.0e-9,
        phi_dof_count: 8,
        augmented_phi_dof_count: 9,
        poisson_constraint_relative_residual: 1.0e-12,
        magnetic_pair_count: 4,
        airbox_pair_count: 6,
        effective_magnetisation_a_per_m: effective_magnetisation,
        relative_kittel_frequency_error: 0.0,
    });

    let artifacts = k0_kittel_validation_auxiliary_artifacts(&result)
        .expect("periodic_airbox_k0 should accept real PA-E4b metrics");
    assert!(artifacts
        .iter()
        .any(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/points.v1.csv"));
    assert!(artifacts
        .iter()
        .any(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/summary.v1.json"));
    let convergence = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/convergence.v1.csv")
        .expect("periodic_airbox_k0 should emit convergence CSV");
    let convergence_csv =
        std::str::from_utf8(&convergence.bytes).expect("convergence should be UTF-8 CSV");
    assert!(convergence_csv.contains("periodic_airbox_k0"));
    assert!(convergence_csv.contains("poisson_residual_relative"));

    let summary_artifact = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/summary.v1.json")
        .expect("summary should be emitted");
    let summary: Value =
        serde_json::from_slice(&summary_artifact.bytes).expect("summary should be valid JSON");
    assert_eq!(summary["status"], "passed");
    assert_eq!(summary["case_id"], "K0-3");
    assert_eq!(summary["demag_kind"], "periodic_airbox_k0");
    assert_eq!(summary["demag"]["gauge_policy"], "mean_zero_augmented");
    assert_eq!(summary["demag"]["phi_dof_count"], 8);
    assert_eq!(summary["demag"]["augmented_phi_dof_count"], 9);
    assert_eq!(summary["demag"]["magnetic_pair_count"], 4);
    assert_eq!(summary["demag"]["airbox_pair_count"], 6);
    assert_eq!(summary["demag"]["production_periodic_airbox_claim"], true);
    assert!(
        summary["demag"]["poisson_constraint_relative_residual"]
            .as_f64()
            .expect("poisson residual should be numeric")
            <= 1.0e-8
    );
}

#[test]
fn k0_kittel_selector_prefers_uniform_branch_over_frequency_only_match() {
    let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-uniform-selector");
    let mut result = sample_result_with_k0_kittel_sweep();

    result.branches = vec![
        TrackedBranch {
            branch_id: 0,
            label: Some("nonuniform_frequency_match".to_string()),
            points: Vec::new(),
        },
        TrackedBranch {
            branch_id: 1,
            label: Some("uniform_kittel_mode".to_string()),
            points: Vec::new(),
        },
    ];

    for sample_result in &mut result.samples {
        let expected_frequency = sample_result.modes[0].frequency_real_hz;
        let mut nonuniform = sample_result.modes[0].clone();
        nonuniform.raw_mode_index = 0;
        nonuniform.frequency_real_hz = expected_frequency;
        nonuniform.angular_frequency_rad_per_s = std::f64::consts::TAU * expected_frequency;
        nonuniform.eigenvalue_imag = std::f64::consts::TAU * expected_frequency;
        nonuniform.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(-1.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(-1.0, 0.0),
        ]);

        let mut uniform = sample_result.modes[0].clone();
        uniform.raw_mode_index = 1;
        uniform.frequency_real_hz = expected_frequency * 1.001;
        uniform.angular_frequency_rad_per_s = std::f64::consts::TAU * uniform.frequency_real_hz;
        uniform.eigenvalue_imag = std::f64::consts::TAU * uniform.frequency_real_hz;
        uniform.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
        ]);

        sample_result.modes = vec![nonuniform, uniform];
        let sample_index = sample_result.sample.sample_index;
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 0,
            frequency_real_hz: expected_frequency,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
        });
        result.branches[1].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 1,
            frequency_real_hz: expected_frequency * 1.001,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
        });
    }

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let summary: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("validation/kittel_k0_pbc/summary.v1.json"))
            .expect("Kittel k0 summary should be written"),
    )
    .expect("Kittel k0 summary should be valid JSON");
    assert_eq!(summary["selected_branch"]["branch_id"], 1);
    assert!(
        summary["mode_selection"]["minimum_uniformity_score"]
            .as_f64()
            .expect("uniformity score should be numeric")
            > 0.99
    );
}

#[test]
fn k0_kittel_validation_rejects_modes_without_native_vectors() {
    let mut result = sample_result_with_k0_kittel_sweep();
    for sample in &mut result.samples {
        for mode in &mut sample.modes {
            mode.reduced_vector = None;
            mode.lifted_real = None;
            mode.lifted_imag = None;
        }
    }

    let err = k0_kittel_validation_auxiliary_artifacts(&result)
        .expect_err("K0 Kittel validation must not fabricate a uniform mode");
    assert!(err.to_string().contains("no tracked eigen branch"));
}

#[test]
fn k0_kittel_selector_does_not_use_expected_frequency_as_a_tiebreaker() {
    let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-frequency-tiebreaker");
    let mut result = sample_result_with_k0_kittel_sweep();

    result.branches = vec![
        TrackedBranch {
            branch_id: 0,
            label: Some("tracked_branch_zero".to_string()),
            points: Vec::new(),
        },
        TrackedBranch {
            branch_id: 1,
            label: Some("analytical_frequency_match".to_string()),
            points: Vec::new(),
        },
    ];

    for sample_result in &mut result.samples {
        let expected_frequency = sample_result.modes[0].frequency_real_hz;
        let mut branch_zero_mode = sample_result.modes[0].clone();
        branch_zero_mode.raw_mode_index = 0;
        branch_zero_mode.frequency_real_hz = expected_frequency * 1.001;
        branch_zero_mode.angular_frequency_rad_per_s =
            std::f64::consts::TAU * branch_zero_mode.frequency_real_hz;
        branch_zero_mode.eigenvalue_imag = branch_zero_mode.angular_frequency_rad_per_s;
        branch_zero_mode.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
        ]);

        let mut analytical_match_mode = sample_result.modes[0].clone();
        analytical_match_mode.raw_mode_index = 1;
        analytical_match_mode.frequency_real_hz = expected_frequency;
        analytical_match_mode.angular_frequency_rad_per_s =
            std::f64::consts::TAU * analytical_match_mode.frequency_real_hz;
        analytical_match_mode.eigenvalue_imag = analytical_match_mode.angular_frequency_rad_per_s;
        analytical_match_mode.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(1.0, 0.0),
        ]);

        sample_result.modes = vec![branch_zero_mode, analytical_match_mode];
        let sample_index = sample_result.sample.sample_index;
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 0,
            frequency_real_hz: expected_frequency * 1.001,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
        });
        result.branches[1].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 1,
            frequency_real_hz: expected_frequency,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
        });
    }

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let summary: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("validation/kittel_k0_pbc/summary.v1.json"))
            .expect("Kittel k0 summary should be written"),
    )
    .expect("Kittel k0 summary should be valid JSON");
    assert_eq!(summary["selected_branch"]["branch_id"], 0);
    assert!(
        summary["max_relative_frequency_error"]
            .as_f64()
            .expect("relative error should be numeric")
            > 0.0009
    );
}

#[test]
fn k0_kittel_selector_uses_mass_weighted_uniformity_when_weights_are_available() {
    let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-mass-weighted-selector");
    let mut result = sample_result_with_k0_kittel_sweep();

    result.branches = vec![
        TrackedBranch {
            branch_id: 0,
            label: Some("unweighted_uniform_only".to_string()),
            points: Vec::new(),
        },
        TrackedBranch {
            branch_id: 1,
            label: Some("mass_weighted_uniform".to_string()),
            points: Vec::new(),
        },
    ];

    for sample_result in &mut result.samples {
        let expected_frequency = sample_result.modes[0].frequency_real_hz;
        let mass_weights = vec![1000.0, 1.0];

        let mut unweighted_uniform = sample_result.modes[0].clone();
        unweighted_uniform.raw_mode_index = 0;
        unweighted_uniform.frequency_real_hz = expected_frequency;
        unweighted_uniform.angular_frequency_rad_per_s = std::f64::consts::TAU * expected_frequency;
        unweighted_uniform.eigenvalue_imag = std::f64::consts::TAU * expected_frequency;
        unweighted_uniform.reduced_vector = Some(vec![
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        unweighted_uniform.node_mass_weights = Some(mass_weights.clone());

        let mut mass_weighted_uniform = sample_result.modes[0].clone();
        mass_weighted_uniform.raw_mode_index = 1;
        mass_weighted_uniform.frequency_real_hz = expected_frequency * 1.001;
        mass_weighted_uniform.angular_frequency_rad_per_s =
            std::f64::consts::TAU * mass_weighted_uniform.frequency_real_hz;
        mass_weighted_uniform.eigenvalue_imag =
            std::f64::consts::TAU * mass_weighted_uniform.frequency_real_hz;
        mass_weighted_uniform.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(-1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        mass_weighted_uniform.node_mass_weights = Some(mass_weights);

        sample_result.modes = vec![unweighted_uniform, mass_weighted_uniform];
        let sample_index = sample_result.sample.sample_index;
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 0,
            frequency_real_hz: expected_frequency,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
        });
        result.branches[1].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 1,
            frequency_real_hz: expected_frequency * 1.001,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
        });
    }

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let summary: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("validation/kittel_k0_pbc/summary.v1.json"))
            .expect("Kittel k0 summary should be written"),
    )
    .expect("Kittel k0 summary should be valid JSON");
    assert_eq!(summary["selected_branch"]["branch_id"], 1);
}

#[test]
fn field_sweep_builder_does_not_fabricate_bias_field_from_kittel_metadata() {
    let result = sample_result_with_k0_kittel_sweep();
    let artifact = build_frequency_domain_field_sweep_artifact(&result)
        .expect("field-sweep builder should validate the source");
    assert!(
        artifact.is_none(),
        "Kittel oracle metadata is not a physical bias-field source"
    );
}

#[test]
fn field_sweep_builder_preserves_sample_and_mode_identity_and_marks_missing_handoff_partial() {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "external_field_a_per_m": [40_000.0, 0.0, 0.0],
        "mesh_id": "mesh:test",
        "topology_revision": "mesh-rev:1",
        "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "operator_input_signature_sha256": "sha256:operator",
        "equilibrium_artifact_sha256": "sha256:equilibrium",
        "linearization_state_sha256": "sha256:linearization",
        "status": "completed"
    }));
    let artifact = build_frequency_domain_field_sweep_artifact(&result)
        .expect("field-sweep builder should validate the source")
        .expect("declared physical bias field should produce an artifact");
    assert_eq!(artifact.schema_version, "eigen/field_sweep.v1");
    assert_eq!(artifact.status, ServerArtifactStatus::Complete);
    assert!(artifact.complete);
    assert_eq!(artifact.samples[0].sample_id, "bias-field-sample-0000");
    assert_eq!(
        artifact.samples[0].modes[0].sample_id,
        "bias-field-sample-0000"
    );
    assert_eq!(
        artifact.samples[0].modes[0].mode_id,
        "sample-0000/mode-0000"
    );
    assert_eq!(artifact.samples[0].bias_field_a_per_m, [40_000.0, 0.0, 0.0]);
    assert_eq!(
        artifact.samples[0].modes[0].mode_field_id,
        Some("analysis:eigen:sample-0000:mode-0000".to_string())
    );
    assert_eq!(
        artifact.samples[0]
            .operator_input_signature_sha256
            .as_deref(),
        Some("sha256:operator")
    );
}

#[test]
fn partial_field_sweep_uses_declared_requested_count_and_completed_statuses() {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "external_field_a_per_m": [40_000.0, 0.0, 0.0],
        "mesh_id": "mesh:test",
        "topology_revision": "mesh-rev:1",
        "operator_input_signature_sha256": "sha256:operator",
        "equilibrium_artifact_sha256": "sha256:equilibrium",
        "linearization_state_sha256": "sha256:linearization",
        "status": "completed",
        "field_sweep": {
            "requested_sample_count": 3,
            "completed_sample_count": 1
        }
    }));

    let artifact = build_frequency_domain_field_sweep_artifact(&result)
        .expect("partial field-sweep source should validate")
        .expect("physical bias field should produce a typed artifact");

    assert_eq!(artifact.requested_sample_count, 3);
    assert_eq!(artifact.completed_sample_count, 1);
    assert_eq!(artifact.status, ServerArtifactStatus::Partial);
    assert!(!artifact.complete);
}

#[test]
fn field_sweep_is_spectrum_only_when_cartesian_complex_mode_payload_is_missing() {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "external_field_a_per_m": [40_000.0, 0.0, 0.0],
        "mesh_id": "mesh:test",
        "topology_revision": "mesh-rev:1",
        "operator_input_signature_sha256": "sha256:operator",
        "status": "completed"
    }));
    result.samples[0].modes[0].lifted_real = None;
    result.samples[0].modes[0].lifted_imag = None;

    let artifact = build_frequency_domain_field_sweep_artifact(&result)
        .expect("field sweep builder should not fail")
        .expect("field sweep should still preserve spectrum metadata");
    let mode = &artifact.samples[0].modes[0];

    assert_eq!(mode.mode_field_id, None);
    assert_eq!(mode.mode_field_resource_key, None);
    assert_eq!(
        serde_json::to_value(mode)
            .expect("spectrum-only mode should serialize")
            .get("mode_artifact_path"),
        None
    );
    assert_eq!(mode.field_status, "spectrum-only");
}

#[test]
fn field_sweep_writer_binds_to_published_spectrum_and_branches_bytes() {
    let temp = TempDirGuard::new("field-sweep-published-source-digests");
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "external_field_a_per_m": [40_000.0, 0.0, 0.0],
        "mesh_id": "mesh:test",
        "topology_revision": "mesh-rev:1",
        "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "operator_input_signature_sha256": "sha256:operator",
        "equilibrium_artifact_sha256": "sha256:equilibrium",
        "linearization_state_sha256": "sha256:linearization",
        "status": "completed"
    }));
    write_path_bundle(&temp.path, &result).expect("spectrum should be published first");
    write_branch_bundle(&temp.path, &result).expect("branches should be published first");
    write_mode_bundle(&temp.path, &result).expect("mode metadata should be published first");

    write_frequency_domain_field_sweep_artifact(&temp.path, &result)
        .expect("field sweep should bind published sources");

    let field_sweep: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/field_sweep.v1.json"))
            .expect("field sweep should be written"),
    )
    .expect("field sweep should be valid JSON");
    let spectrum_revision = sha256_prefixed(
        &std::fs::read(temp.path.join("eigen/spectrum.v2.json"))
            .expect("spectrum bytes should be readable"),
    );
    let branches_revision = sha256_prefixed(
        &std::fs::read(temp.path.join("eigen/branches.v2.json"))
            .expect("branches bytes should be readable"),
    );

    assert_eq!(field_sweep["source"]["revision"], spectrum_revision);
    assert_eq!(field_sweep["source_revision"], spectrum_revision);
    assert_eq!(
        field_sweep["cross_artifact_refs"],
        serde_json::json!([
            {"relation": "source_spectrum", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
            {"relation": "source_branches", "artifact": "eigen/branches.v2.json", "revision": branches_revision},
        ])
    );
}

#[test]
fn field_sweep_topology_preserves_verified_mesh_identity_for_result_fields() {
    let topology = topology_from_diagnostics(Some(&serde_json::json!({
        "mesh_id": "mesh:test",
        "topology_revision": "mesh-rev:1",
        "topology_fingerprint":
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mesh_generation_id": "generation:test",
        "node_count": 12
    })));

    assert_eq!(topology.mesh_id, "mesh:test");
    assert_eq!(topology.topology_revision, "mesh-rev:1");
    assert_eq!(
        topology.topology_fingerprint.as_deref(),
        Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(topology.mesh_generation_id.as_deref(), Some("generation:test"));

    let numeric_revision = topology_from_diagnostics(Some(&serde_json::json!({
        "mesh_id": "mesh:test",
        "mesh_revision": 17,
        "source_mesh_topology_sha256":
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    })));
    assert_eq!(numeric_revision.topology_revision, "17");
    assert_eq!(
        numeric_revision.topology_fingerprint.as_deref(),
        Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
}

#[test]
fn typed_artifact_revision_binds_execution_and_topology() {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "external_field_a_per_m": [40_000.0, 0.0, 0.0],
        "mesh_id": "mesh:test",
        "topology_revision": "mesh-rev:1",
        "operator_input_signature_sha256": "sha256:operator",
        "equilibrium_artifact_sha256": "sha256:equilibrium",
        "linearization_state_sha256": "sha256:linearization",
        "status": "completed"
    }));
    let artifact = build_frequency_domain_field_sweep_artifact(&result)
        .expect("field-sweep builder should validate the source")
        .expect("declared physical bias field should produce an artifact");

    assert_eq!(artifact.revision, artifact.content_sha256);
    assert_eq!(artifact.revision, canonical_artifact_digest(&artifact));

    let mut execution_changed = artifact.clone();
    execution_changed.resolved_execution.device = "gpu".to_string();
    assert_ne!(
        artifact.revision,
        canonical_artifact_digest(&execution_changed),
        "execution provenance must be covered by the content revision"
    );

    let mut topology_changed = artifact.clone();
    topology_changed.topology.topology_revision = "mesh-rev:2".to_string();
    assert_ne!(
        artifact.revision,
        canonical_artifact_digest(&topology_changed),
        "topology provenance must be covered by the content revision"
    );
}

#[test]
fn typed_json_writer_replaces_complete_envelope_without_temp_residue() {
    let temp = TempDirGuard::new("typed-json-atomic-writer");
    let path = temp.path.join("fmr/peaks.v1.json");
    write_json_atomic(&path, &serde_json::json!({"revision": "same-length-a"}))
        .expect("first typed artifact publication should succeed");
    write_json_atomic(&path, &serde_json::json!({"revision": "same-length-b"}))
        .expect("replacement typed artifact publication should succeed");

    let value: Value = serde_json::from_slice(
        &std::fs::read(&path).expect("replacement artifact should remain readable"),
    )
    .expect("replacement artifact should remain valid JSON");
    assert_eq!(value["revision"], "same-length-b");
    let temporary_files = std::fs::read_dir(path.parent().expect("parent directory"))
        .expect("typed artifact directory should be readable")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
        .count();
    assert_eq!(temporary_files, 0);
}

#[test]
fn fmr_peaks_are_derived_only_from_driven_response_and_carry_revision() {
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_diagonal_element(1, 1, 1.0),
        mass: DMatrix::from_diagonal_element(1, 1, 1.0),
        damping: Some(DMatrix::from_diagonal_element(1, 1, 0.1)),
    };
    let frequencies = [1.0, 2.0, 3.0, 4.0];
    let excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
    let response = solve_field_driven_block_real_sweep(&template, &frequencies, &excitation)
        .expect("response fixture should solve");
    let source = build_field_driven_response_sweep_artifact(
        &response,
        "test.response",
        "test_solver",
        "gilbert",
        "validation",
    );
    let peaks = build_fmr_peaks_artifact(&source, "sha256:response-source", false)
        .expect("peaks should derive from a valid driven response");
    assert_eq!(peaks.schema_version, "fmr/peaks.v1");
    assert_eq!(peaks.source.kind, FmrPeakSourceKind::DrivenResponse);
    assert_eq!(peaks.source.revision, "sha256:response-source");
    assert_eq!(peaks.units.frequency, "Hz");
    assert_eq!(
        peaks.units.response_amplitude.as_deref(),
        Some("normalized_magnetization")
    );
    assert!(peaks.units.covariance.is_none());
    assert_eq!(peaks.status, ServerArtifactStatus::Complete);
    assert!(!peaks.peaks.is_empty());
    assert!(peaks.peaks.iter().all(|peak| {
        peak.source_artifact == "response/magnetic_response_sweep.v2.json"
            && peak.sample_id.is_none()
            && peak.mode_id.is_none()
            && peak.peak_id == format!("response-peak-{:04}", peak.source_frequency_index)
    }));
}

#[test]
fn fmr_peaks_reject_nonfinite_frequency_source() {
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_diagonal_element(1, 1, 1.0),
        mass: DMatrix::from_diagonal_element(1, 1, 1.0),
        damping: Some(DMatrix::from_diagonal_element(1, 1, 0.1)),
    };
    let response = solve_field_driven_block_real_sweep(
        &template,
        &[1.0, 2.0],
        &DVector::from_element(1, Complex64::new(1.0, 0.0)),
    )
    .expect("response fixture should solve");
    let mut source = build_field_driven_response_sweep_artifact(
        &response,
        "test.response",
        "test_solver",
        "gilbert",
        "validation",
    );
    source.points[0].frequency_hz = f64::NAN;
    let error = build_fmr_peaks_artifact(&source, "sha256:response-source", false)
        .expect_err("non-finite frequency must fail closed");
    assert!(error.to_string().contains("finite non-negative frequency"));
}

#[test]
fn interrupted_response_produces_partial_fmr_artifacts_without_complete_claim() {
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_diagonal_element(1, 1, 1.0),
        mass: DMatrix::from_diagonal_element(1, 1, 1.0),
        damping: Some(DMatrix::from_diagonal_element(1, 1, 0.1)),
    };
    let response = solve_field_driven_block_real_sweep_with_interrupt(
        &template,
        &[1.0, 2.0, 3.0],
        &DVector::from_element(1, Complex64::new(1.0, 0.0)),
        |completed| completed >= 1,
    )
    .expect("response fixture should solve");
    let source = build_field_driven_response_sweep_artifact(
        &response.points,
        "test.response",
        "test_solver",
        "gilbert",
        "validation",
    );
    let peaks = build_fmr_peaks_artifact_with_progress(
        &source,
        "sha256:response-source",
        3,
        response.interrupted,
    )
    .expect("partial response remains a valid derived artifact");
    assert_eq!(peaks.status, ServerArtifactStatus::Interrupted);
    assert!(!peaks.complete);
    assert!(peaks.interrupted);
    assert_eq!(peaks.requested_point_count, 3);
    assert_eq!(peaks.completed_point_count, 1);

    let temp = TempDirGuard::new("response-artifact-interrupted-fmr");
    write_response_sweep_bundle_with_progress(&temp.path, &source, 3, true)
        .expect("interrupted response writer should preserve typed analysis artifacts");
    let written_peaks: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("fmr/peaks.v1.json"))
            .expect("interrupted peaks artifact should be written"),
    )
    .expect("interrupted peaks artifact should be valid JSON");
    let written_fits: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("fmr/resonance_fits.v1.json"))
            .expect("interrupted fits artifact should be written"),
    )
    .expect("interrupted fits artifact should be valid JSON");
    assert_eq!(written_peaks["status"], "interrupted");
    assert_eq!(written_peaks["complete"], false);
    assert_eq!(written_fits["status"], "interrupted");
    assert_eq!(written_fits["complete"], false);
}

#[test]
fn kittel_fit_contains_only_postsolve_comparison_and_digest_bound_source() {
    let result = sample_result_with_k0_kittel_sweep();
    let fit = build_kittel_fit_artifact(&result)
        .expect("Kittel fit artifact should be derivable from a solved oracle fixture")
        .expect("fixture declares a postsolve Kittel oracle");
    assert_eq!(fit.schema_version, "fmr/kittel_fit.v1");
    assert_eq!(fit.model, "macrospin_larmor");
    assert_eq!(fit.units.frequency, "Hz");
    assert_eq!(fit.points.len(), 3);
    assert!(fit
        .points
        .iter()
        .all(|point| point.sample_id.starts_with("bias-field-sample-")));
    assert!(fit
        .points
        .iter()
        .all(|point| point.mode_id == "sample-0000/mode-0000"
            || point.mode_id == "sample-0001/mode-0000"
            || point.mode_id == "sample-0002/mode-0000"));
    assert!(fit.source.revision.starts_with("sha256:"));
    assert!(!fit.source.revision.is_empty());
    assert_eq!(fit.status, ServerArtifactStatus::Partial);
    assert!(!fit.complete);
    assert_eq!(
        fit.stop_reason.as_deref(),
        Some("statistical_fit_covariance_not_available")
    );
}

#[test]
fn eigen_manifest_carries_k0_kittel_validation_contract() {
    let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-validation");
    let result = sample_result_with_k0_kittel_sweep();

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain eigen manifest should be written"),
    )
    .expect("frequency-domain eigen manifest should be valid JSON");

    assert_eq!(
        manifest["validation"]["k0_kittel_validation"]["kind"],
        "k0_kittel_field_sweep"
    );
    assert_eq!(
        manifest["validation"]["k0_kittel_validation"]["model"],
        "macrospin_larmor"
    );
    assert_eq!(
        manifest["validation"]["k0_kittel_validation"]["field_units"],
        "A_per_m"
    );
    assert_eq!(
        manifest["validation"]["k0_kittel_validation"]["material"]["effective_magnetisation"],
        Value::Null
    );
    assert_eq!(
        manifest["validation"]["k0_kittel_validation"]["samples"]
            .as_array()
            .expect("samples should be an array")
            .len(),
        3
    );
    assert!(manifest["artifacts"]["field_sweep_v1_path"].is_null());
    assert_eq!(
        manifest["artifacts"]["fmr_kittel_fit_v1_path"],
        "fmr/kittel_fit.v1.json"
    );
}

#[test]
fn production_dispersion_with_de_bv_validation_writes_analytic_columns() {
    let temp = TempDirGuard::new("eigen-artifacts-production-de-bv-analytic");
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    result.samples[0].sample.k_vector = [1.5e6, 0.0, 0.0];
    result.samples[0].sample.path_s = 1.5e6;
    result.include_demag = true;
    result.dispersion_validation = Some(fullmag_ir::FemEigenDispersionValidationIR {
        kind: "thin_film_de_bv_low_k".to_string(),
        analytic_model: "kalinikos_slab_n0".to_string(),
        film_thickness_m: 20e-9,
        equilibrium_magnetization: [1.0, 0.0, 0.0],
        film_normal: [0.0, 0.0, 1.0],
        frequency_window_hz: fullmag_ir::FemEigenDispersionValidationWindowIR {
            min: 0.0,
            max: 5.0e9,
        },
        max_k_rad_per_m: 3.0e6,
        max_relative_error: 0.10,
        scenarios: vec![fullmag_ir::FemEigenDispersionValidationScenarioIR {
            geometry: "backward_volume".to_string(),
            branch_id: "branch_0".to_string(),
            sample_indices: vec![0],
        }],
    });
    result.dispersion_analytic_reference =
        Some(crate::eigen::types::DispersionAnalyticReferenceContext {
            external_field: [40_000.0, 0.0, 0.0],
            exchange_stiffness: 3.5e-12,
            saturation_magnetisation: 140e3,
            gyromagnetic_ratio: 2.211e5,
        });
    let expected_analytic = kalinikos_slab_n0_frequency_hz(
        vector_norm(result.samples[0].sample.k_vector),
        "backward_volume",
        40_000.0,
        20e-9,
        3.5e-12,
        140e3,
        2.211e5,
    );
    result.samples[0].modes[0].frequency_real_hz = expected_analytic * 1.01;
    result.samples[0].modes[0].angular_frequency_rad_per_s =
        std::f64::consts::TAU * result.samples[0].modes[0].frequency_real_hz;

    write_path_bundle(&temp.path, &result).expect("path bundle should write");
    write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain manifest should write");

    let dispersion = std::fs::read_to_string(temp.path.join("eigen/dispersion.csv"))
        .expect("dispersion.csv should be written");
    let mut lines = dispersion.lines();
    let header: Vec<&str> = lines
        .next()
        .expect("dispersion header should exist")
        .split(',')
        .collect();
    let row: Vec<&str> = lines
        .next()
        .expect("dispersion row should exist")
        .split(',')
        .collect();
    let column = |name: &str| {
        header
            .iter()
            .position(|column| *column == name)
            .expect("dispersion column should exist")
    };
    assert_eq!(row[column("validation_geometry")], "backward_volume");
    let analytic: f64 = row[column("analytic_frequency_hz")]
        .parse()
        .expect("analytic_frequency_hz should parse");
    let relative_error: f64 = row[column("relative_error")]
        .parse()
        .expect("relative_error should parse");
    assert!((analytic - expected_analytic).abs() / expected_analytic < 1.0e-12);
    assert!((relative_error - 0.01).abs() < 1.0e-12);

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain manifest should be written"),
    )
    .expect("frequency-domain manifest should parse");
    assert_eq!(
        manifest["requested_execution"]["include_demag"],
        Value::Bool(true)
    );
    assert_eq!(
        manifest["validation"]["dispersion_frequency_source"],
        "numeric_modal_solver_with_analytic_comparison"
    );
    assert_eq!(
        manifest["validation"]["dynamic_demag_operator_source"],
        "numeric_modal_solver"
    );
    assert!(manifest["validation"]
        .get("dispersion_reference_model")
        .is_none());
}

#[test]
fn de_bv_reference_manifest_names_analytic_frequency_source_not_demag_k() {
    let temp = TempDirGuard::new("eigen-artifacts-de-bv-reference-source");
    let mut result =
        sample_result_with_solver_model(EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0);
    result.include_demag = true;
    result.samples[0].sample.path_s = 1.0;
    result.samples[0].sample.k_vector = [3.0e6, 0.0, 0.0];
    result.dispersion_validation = Some(fullmag_ir::FemEigenDispersionValidationIR {
        kind: "thin_film_de_bv_low_k".to_string(),
        analytic_model: "kalinikos_slab_n0".to_string(),
        film_thickness_m: 20e-9,
        equilibrium_magnetization: [1.0, 0.0, 0.0],
        film_normal: [0.0, 0.0, 1.0],
        frequency_window_hz: fullmag_ir::FemEigenDispersionValidationWindowIR {
            min: 0.0,
            max: 5.0e9,
        },
        max_k_rad_per_m: 3.0e6,
        max_relative_error: 0.10,
        scenarios: vec![fullmag_ir::FemEigenDispersionValidationScenarioIR {
            geometry: "backward_volume".to_string(),
            branch_id: "branch_0".to_string(),
            sample_indices: vec![0],
        }],
    });

    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain manifest should write");

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain manifest should be written"),
    )
    .expect("frequency-domain manifest should parse");
    assert_eq!(
        manifest["requested_execution"]["include_demag"],
        Value::Bool(true)
    );
    assert_eq!(
        manifest["validation"]["dispersion_frequency_source"],
        "analytic_reference_model"
    );
    assert_eq!(
        manifest["validation"]["dispersion_reference_model"],
        "kalinikos_slab_n0"
    );
    assert_eq!(
        manifest["validation"]["dynamic_demag_operator_source"],
        "analytic_thin_film_de_bv_reference_not_fem_demag_k"
    );
}

#[test]
fn production_cpu_shift_invert_mode_artifacts_use_production_phasor_contract() {
    let temp = TempDirGuard::new("eigen-artifacts-production-phasor");
    let result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);

    write_path_bundle(&temp.path, &result).expect("path bundle should write");
    write_mode_bundle(&temp.path, &result).expect("mode bundle should write");

    let eigen_dir = temp.path.join("eigen");
    let spectrum: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("spectrum.v2.json"))
            .expect("spectrum.v2.json should be written"),
    )
    .expect("spectrum.v2.json should be valid JSON");
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["phasor_convention"],
        "exp_i_omega_t"
    );
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["eigenvalue_mapping"],
        "lambda_eq_i_omega"
    );

    let nested_mode: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("modes/sample_0000/mode_0000.json"))
            .expect("nested mode artifact should be written"),
    )
    .expect("nested mode artifact should be valid JSON");
    assert_eq!(nested_mode["phasor_convention"], "exp_i_omega_t");
    assert_eq!(nested_mode["eigenvalue_mapping"], "lambda_eq_i_omega");
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
    assert_eq!(value["points"][0]["point_id"], "frequency-point-0000");
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
    assert_eq!(
        value["points"][0]["excitation_provenance"]["phase_rad"],
        0.0
    );
}

#[test]
fn response_artifact_bundle_emits_partial_progress_files() {
    let temp = TempDirGuard::new("response-artifact-bundle");
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_element(1, 1, 4.0),
        mass: DMatrix::from_element(1, 1, 1.0),
        damping: Some(DMatrix::from_element(1, 1, 0.5)),
    };
    let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
    let sweep = solve_field_driven_block_real_sweep(&template, &[2.0, 3.0], &field_excitation)
        .expect("field-driven sweep should solve");
    let artifact = build_field_driven_response_sweep_artifact(
        &sweep,
        "runner.dense_block_real",
        "dense_block_real_lu",
        "gilbert_linear",
        "local_validation",
    );

    write_response_sweep_bundle(&temp.path, &artifact).expect("response sweep bundle should write");

    let response_dir = temp.path.join("response");
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(response_dir.join("artifact_manifest.json"))
            .expect("artifact manifest should be written"),
    )
    .expect("artifact manifest should be valid JSON");
    let point: Value = serde_json::from_slice(
        &std::fs::read(response_dir.join("frequency_points/frequency_0001.json"))
            .expect("second frequency point should be written"),
    )
    .expect("frequency point should be valid JSON");

    assert_eq!(
        manifest["schema_version"],
        "frequency_response_artifact_manifest.v1"
    );
    assert_eq!(manifest["frequency_point_count"], 2);
    assert_eq!(
        manifest["frequency_point_artifacts"][1],
        "response/frequency_points/frequency_0001.json"
    );
    assert_eq!(point["schema_version"], "frequency_response_point.v1");
    assert_eq!(point["point_id"], "frequency-point-0001");
    assert_eq!(point["frequency_index"], 1);
    assert_eq!(point["point"]["angular_frequency_rad_per_s"], 3.0);
    assert_eq!(
        point["response_field_payload_path"],
        "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
    );
    assert_eq!(
        point["field_payload_path"],
        "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
    );
    assert_eq!(point["storage_format"], "zarr");
    assert_eq!(point["zarr_store_path"], "response/field_payloads.zarr");
    assert_eq!(
        point["compatibility_binary_payload_path"],
        "response/field_payloads/frequency_0001/vector.bin"
    );
    assert_eq!(point["payload_encoding"], "f64_interleaved_real_imag_xyz");
    assert_eq!(point["binary_layout"], "complex_f64_pairs_little_endian");
    assert_eq!(point["value_kind"], "complex_spatial_vector");
    assert_eq!(point["component_basis"], "global_xyz");
    assert_eq!(point["component_count"], 3);
    assert_eq!(point["components"], serde_json::json!(["x", "y", "z"]));
    assert_eq!(point["complex_pair_count"], 3);
    assert_eq!(point["payload_value_count"], 6);
    assert_eq!(point["zarr_shape"], serde_json::json!([1, 3, 2]));
    assert_eq!(point["zarr_chunk_shape"], serde_json::json!([1, 3, 2]));
    assert_eq!(
        point["available_views"],
        serde_json::json!([
            "complex",
            "real",
            "imag",
            "abs",
            "amplitude",
            "phase",
            "phase_rotated_real"
        ])
    );
    assert_eq!(point["default_view"], "phase_rotated_real");
    assert_eq!(point["default_phase_rad"], 0.0);
    let payload = std::fs::read(
        response_dir.join("field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"),
    )
    .expect("response field Zarr payload should be written");
    assert_eq!(payload.len(), 48);
    let zattrs: Value = serde_json::from_slice(
        &std::fs::read(
            response_dir.join("field_payloads.zarr/frequency_0001/vector_xyz_complex/.zattrs"),
        )
        .expect("response field Zarr attrs should be written"),
    )
    .expect("response field Zarr attrs should be valid JSON");
    assert_eq!(zattrs["quantity_id"], "dynamic_response");
    assert_eq!(
        zattrs["axes"],
        serde_json::json!(["spatial_sample", "component", "complex"])
    );
    assert_eq!(
        zattrs["component_order"],
        serde_json::json!(["x", "y", "z"])
    );
    assert_eq!(zattrs["complex_order"], serde_json::json!(["real", "imag"]));
    assert!(response_dir
        .join("field_payloads/frequency_0001/vector.bin")
        .is_file());
    assert!(response_dir
        .join("magnetic_response_sweep.v1.json")
        .is_file());

    let peaks: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("fmr/peaks.v1.json"))
            .expect("typed FMR peaks artifact should be written"),
    )
    .expect("typed FMR peaks artifact should be valid JSON");
    assert_eq!(peaks["schema_version"], "fmr/peaks.v1");
    assert_eq!(
        peaks["source"]["artifact"],
        "response/magnetic_response_sweep.v2.json"
    );
    assert_eq!(peaks["status"], "complete");
    assert_eq!(peaks["complete"], true);

    let fits: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("fmr/resonance_fits.v1.json"))
            .expect("typed resonance fits artifact should be written"),
    )
    .expect("typed resonance fits artifact should be valid JSON");
    assert_eq!(fits["schema_version"], "fmr/resonance_fits.v1");
    assert_eq!(fits["source"]["artifact"], "fmr/peaks.v1.json");
    assert_eq!(fits["complete"], false);
}

#[test]
fn dense_validation_response_entrypoint_solves_and_writes_bundle() {
    let temp = TempDirGuard::new("response-solve-write-bundle");
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_element(1, 1, 4.0),
        mass: DMatrix::from_element(1, 1, 1.0),
        damping: Some(DMatrix::from_element(1, 1, 0.5)),
    };
    let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

    let artifact = solve_and_write_field_driven_response_sweep_bundle(
        &temp.path,
        &template,
        &[2.0, 3.0],
        &field_excitation,
        "runner.dense_block_real",
        "dense_block_real_lu",
        "gilbert_linear",
        "local_validation",
    )
    .expect("dense validation response entrypoint should solve and write");

    assert_eq!(artifact.schema_version, "magnetic_response_sweep.v1");
    assert_eq!(artifact.point_count, 2);
    assert!(temp
        .path
        .join("response/frequency_points/frequency_0000.json")
        .is_file());
    assert!(temp.path.join("response/artifact_manifest.json").is_file());
    let response_v2: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/magnetic_response_sweep.v2.json"))
            .expect("response v2 sweep should be written"),
    )
    .expect("response v2 sweep should be valid JSON");
    assert_eq!(response_v2["schema_version"], "magnetic_response_sweep.v2");
    assert_eq!(response_v2["solve_kind"], "direct_harmonic_response");
    assert_eq!(
        response_v2["source_sweep_artifact"],
        "response/magnetic_response_sweep.v1.json"
    );
    assert_eq!(response_v2["status"], "completed");
    assert_eq!(response_v2["complete"], true);
    assert_eq!(response_v2["completed_frequency_point_count"], 2);
    assert_eq!(response_v2["points"][1]["point_id"], "frequency-point-0001");
    assert_eq!(
        response_v2["frequency_point_artifact_paths"][1],
        "response/frequency_points/frequency_0001.json"
    );
    assert_eq!(
        response_v2["response_field_payload_paths"][1],
        "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
    );
    assert_eq!(
        response_v2["points"][1]["frequency_point_artifact_path"],
        "response/frequency_points/frequency_0001.json"
    );
    assert_eq!(
        response_v2["points"][1]["response_field_payload_path"],
        "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
    );
    assert_eq!(response_v2["points"][1]["storage_format"], "zarr");
    assert_eq!(
        response_v2["points"][1]["compatibility_binary_payload_path"],
        "response/field_payloads/frequency_0001/vector.bin"
    );
    assert_eq!(
        response_v2["points"][1]["excitation_provenance"]["kind"],
        "field"
    );
    assert_eq!(
        response_v2["points"][1]["excitation_provenance"]["phase_rad"],
        0.0
    );
    assert!(
        response_v2["points"][1]["phase_rad"].is_number(),
        "response v2 point should expose scalar phase for charting"
    );
    let family_manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain manifest should be written"),
    )
    .expect("frequency-domain manifest should be valid JSON");
    assert_eq!(
        family_manifest["artifacts"]["response_sweep_v2_path"],
        "response/magnetic_response_sweep.v2.json"
    );
    assert_eq!(
        family_manifest["artifacts"]["fmr_peaks_v1_path"],
        "fmr/peaks.v1.json"
    );
    assert_eq!(
        family_manifest["artifacts"]["fmr_resonance_fits_v1_path"],
        "fmr/resonance_fits.v1.json"
    );
    assert!(
        family_manifest["artifacts"]["response_map_v1_path"].is_null(),
        "frequency response sweep must not claim a response-map v1 artifact"
    );
    assert!(
        family_manifest["artifacts"]["response_map_v2_path"].is_null(),
        "frequency response sweep must not claim a response-map v2 artifact"
    );
    assert!(
        family_manifest["resources"]["response_map_resource_key"].is_null(),
        "frequency response sweep must not claim a response-map resource"
    );
    assert_eq!(
        family_manifest["requested_execution"]["solver_family"],
        "frequency_response"
    );
    assert_eq!(
        family_manifest["requested_execution"]["solve_equation"],
        "(i omega B - L) q = f"
    );
    assert_eq!(
        family_manifest["resolved_execution"]["solve_kind"],
        "direct_harmonic_response"
    );
    assert_eq!(
        family_manifest["resolved_execution"]["native_backend"],
        "runner_validation"
    );
    assert_eq!(
        family_manifest["resolved_execution"]["reference_or_production"],
        "reference"
    );
    assert_eq!(
        family_manifest["capabilities"]["production_native_solver_available"],
        false
    );
    assert_eq!(family_manifest["capabilities"]["validation_artifact"], true);
    let progress: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/progress.v1.json"))
            .expect("response progress should be written"),
    )
    .expect("response progress should be valid JSON");
    assert_eq!(progress["status"], "ready");
    assert_eq!(progress["complete"], true);
    assert_eq!(progress["total_frequency_points"], 2);
    assert_eq!(progress["completed_frequency_points"], 2);
    assert_eq!(progress["written_frequency_point_artifacts"], 2);
    assert_eq!(progress["partial_artifacts_available"], true);
    assert!(progress["progress_json"]
        .as_str()
        .expect("progress_json should be a string")
        .contains("\"state\":\"completed\""));
}

#[test]
fn dense_validation_response_entrypoint_writes_interrupted_partial_bundle() {
    let temp = TempDirGuard::new("response-interrupted-bundle");
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_element(1, 1, 4.0),
        mass: DMatrix::from_element(1, 1, 1.0),
        damping: Some(DMatrix::from_element(1, 1, 0.5)),
    };
    let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

    let artifact = solve_and_write_field_driven_response_sweep_bundle_with_interrupt(
        &temp.path,
        &template,
        &[2.0, 3.0, 4.0],
        &field_excitation,
        |completed_points| completed_points >= 1,
        "runner.dense_block_real",
        "dense_block_real_lu",
        "gilbert_linear",
        "local_validation",
    )
    .expect("interrupted dense validation response should write partial bundle");

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/artifact_manifest.json"))
            .expect("artifact manifest should be written"),
    )
    .expect("artifact manifest should be valid JSON");
    let family_manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain manifest should be written"),
    )
    .expect("frequency-domain manifest should be valid JSON");

    assert_eq!(artifact.point_count, 1);
    assert_eq!(manifest["requested_frequency_point_count"], 3);
    assert_eq!(manifest["completed_frequency_point_count"], 1);
    assert_eq!(manifest["frequency_point_count"], 1);
    assert_eq!(manifest["status"], "interrupted");
    assert_eq!(manifest["complete"], false);
    assert_eq!(manifest["interrupted"], true);
    assert_eq!(manifest["cancellation_reason"], "interrupt_requested");
    assert_eq!(
        family_manifest["schema_version"],
        "frequency_domain_manifest.v1"
    );
    assert_eq!(
        family_manifest["analysis_family"],
        "magnetic_frequency_domain"
    );
    assert_eq!(family_manifest["study_product"], "driven_response");
    assert_eq!(family_manifest["stage_kind"], "frequency_response");
    assert_eq!(family_manifest["diagnostics"]["status"], "interrupted");
    assert_eq!(family_manifest["diagnostics"]["complete"], false);
    assert_eq!(
        family_manifest["artifacts"]["response_sweep_v1_path"],
        "response/magnetic_response_sweep.v1.json"
    );
    assert_eq!(
        family_manifest["artifacts"]["solver_diagnostics_path"],
        "response/diagnostics/solver.v1.json"
    );
    assert_eq!(
        family_manifest["artifacts"]["response_diagnostics_v1_path"],
        "response/diagnostics/solver.v1.json"
    );
    assert_eq!(
        family_manifest["artifacts"]["response_progress_v1_path"],
        "response/progress.v1.json"
    );
    assert_eq!(
        family_manifest["artifacts"]["response_cancel_requested_v1_path"],
        "response/cancel_requested.v1.json"
    );
    assert!(
        family_manifest["artifacts"]["response_map_v1_path"].is_null(),
        "partial response sweep must not claim a response-map v1 artifact"
    );
    assert!(
        family_manifest["artifacts"]["response_map_v2_path"].is_null(),
        "partial response sweep must not claim a response-map v2 artifact"
    );
    assert!(
        family_manifest["resources"]["response_map_resource_key"].is_null(),
        "partial response sweep must not claim a response-map resource"
    );
    assert_eq!(
        family_manifest["resources"]["response_progress_resource_key"],
        "/v2/sessions/current/analysis/frequency-domain/response/progress.v1"
    );
    assert_eq!(
        family_manifest["resources"]["response_cancel_requested_resource_key"],
        "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1"
    );
    assert_eq!(
        family_manifest["resources"]["response_diagnostics_resource_key"],
        "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1"
    );
    let diagnostics: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/diagnostics/solver.v1.json"))
            .expect("response diagnostics should be written"),
    )
    .expect("response diagnostics should be valid JSON");
    assert_eq!(
        diagnostics["schema_version"],
        "frequency_domain_response_diagnostics.v1"
    );
    assert_eq!(diagnostics["solve_kind"], "direct_harmonic_response");
    assert_eq!(diagnostics["status"], "interrupted");
    assert_eq!(diagnostics["complete"], false);
    assert_eq!(diagnostics["completed_frequency_point_count"], 1);
    let progress: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/progress.v1.json"))
            .expect("response progress should be written"),
    )
    .expect("response progress should be valid JSON");
    assert_eq!(
        progress["schema_version"],
        "frequency_domain_sweep_progress.v1"
    );
    assert_eq!(progress["status"], "interrupted");
    assert_eq!(progress["complete"], false);
    assert_eq!(progress["total_frequency_points"], 3);
    assert_eq!(progress["completed_frequency_points"], 1);
    assert_eq!(progress["written_frequency_point_artifacts"], 1);
    assert_eq!(progress["partial_artifacts_available"], true);
    assert_eq!(
        progress["latest_artifact_manifest_path"],
        "response/artifact_manifest.json"
    );
    let cancel_requested: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/cancel_requested.v1.json"))
            .expect("cancel-requested progress should be written"),
    )
    .expect("cancel-requested progress should be valid JSON");
    assert_eq!(
        cancel_requested["schema_version"],
        "frequency_domain_sweep_progress.v1"
    );
    assert_eq!(cancel_requested["status"], "cancel_requested");
    assert_eq!(cancel_requested["complete"], false);
    assert_eq!(cancel_requested["total_frequency_points"], 3);
    assert_eq!(cancel_requested["completed_frequency_points"], 1);
    assert_eq!(cancel_requested["written_frequency_point_artifacts"], 1);
    assert_eq!(cancel_requested["partial_artifacts_available"], true);
    assert!(cancel_requested["progress_json"]
        .as_str()
        .expect("cancel-requested progress_json should be a string")
        .contains("\"state\":\"cancel_requested\""));
    assert!(temp
        .path
        .join("response/frequency_points/frequency_0000.json")
        .is_file());
    assert!(temp
        .path
        .join("response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0")
        .is_file());
    assert!(temp
        .path
        .join("response/field_payloads/frequency_0000/vector.bin")
        .is_file());
    assert!(!temp
        .path
        .join("response/frequency_points/frequency_0001.json")
        .exists());
    assert!(!temp
        .path
        .join("response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0")
        .exists());
    assert!(!temp
        .path
        .join("response/field_payloads/frequency_0001/vector.bin")
        .exists());
}

#[test]
fn dense_validation_response_entrypoint_writes_pre_first_point_cancel_bundle() {
    let temp = TempDirGuard::new("response-pre-first-point-cancel-bundle");
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_element(1, 1, 4.0),
        mass: DMatrix::from_element(1, 1, 1.0),
        damping: Some(DMatrix::from_element(1, 1, 0.5)),
    };
    let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

    let artifact = solve_and_write_field_driven_response_sweep_bundle_with_interrupt(
        &temp.path,
        &template,
        &[2.0, 3.0, 4.0],
        &field_excitation,
        |completed_points| completed_points == 0,
        "runner.dense_block_real",
        "dense_block_real_lu",
        "gilbert_linear",
        "local_validation",
    )
    .expect("pre-first-point cancellation should write an interrupted bundle");

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/artifact_manifest.json"))
            .expect("artifact manifest should be written"),
    )
    .expect("artifact manifest should be valid JSON");
    let progress: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/progress.v1.json"))
            .expect("response progress should be written"),
    )
    .expect("response progress should be valid JSON");
    let cancel_requested: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("response/cancel_requested.v1.json"))
            .expect("cancel-requested progress should be written"),
    )
    .expect("cancel-requested progress should be valid JSON");

    assert_eq!(artifact.point_count, 0);
    assert_eq!(manifest["requested_frequency_point_count"], 3);
    assert_eq!(manifest["completed_frequency_point_count"], 0);
    assert_eq!(manifest["frequency_point_count"], 0);
    assert_eq!(manifest["status"], "interrupted");
    assert_eq!(manifest["complete"], false);
    assert_eq!(manifest["interrupted"], true);
    assert_eq!(progress["status"], "interrupted");
    assert_eq!(progress["completed_frequency_points"], 0);
    assert_eq!(progress["written_frequency_point_artifacts"], 0);
    assert_eq!(progress["partial_artifacts_available"], false);
    assert!(progress["progress_json"]
        .as_str()
        .expect("progress_json should be a string")
        .contains("\"partial_artifacts_available\":false"));
    assert_eq!(cancel_requested["status"], "cancel_requested");
    assert_eq!(cancel_requested["completed_frequency_points"], 0);
    assert_eq!(cancel_requested["written_frequency_point_artifacts"], 0);
    assert_eq!(cancel_requested["partial_artifacts_available"], false);
    assert!(cancel_requested["progress_json"]
        .as_str()
        .expect("cancel-requested progress_json should be a string")
        .contains("\"partial_artifacts_available\":false"));
    assert!(!temp
        .path
        .join("response/frequency_points/frequency_0000.json")
        .exists());
    assert!(!temp
        .path
        .join("response/field_payloads/frequency_0000/vector.bin")
        .exists());
    assert!(!temp
        .path
        .join("response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0")
        .exists());
}
