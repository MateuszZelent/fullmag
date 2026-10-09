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

#[test]
fn branch_writer_preserves_recorded_pair_policy_and_gap() {
    let temp = TempDirGuard::new("tracking-edge");
    let mut result = sample_result();
    result.samples[0].modes[0].reduced_vector = Some(vec![Complex64::new(1.0, 0.0); 3]);
    let mut empty = result.samples[0].clone();
    empty.sample.sample_index = 1;
    empty.modes.clear();
    let mut next = result.samples[0].clone();
    next.sample.sample_index = 2;
    next.modes[0].raw_mode_index = 13;
    next.modes[0].reduced_vector = Some(vec![Complex64::new(0.0, 1.0); 3]);
    result.samples.extend([empty, next]);
    let cfg = fullmag_ir::ModeTrackingIR { overlap_floor: 0.7, max_branch_gap: 1,
                                         ..fullmag_ir::ModeTrackingIR::default() };
    crate::eigen::tracking::track_branches(&mut result, Some(&cfg));
    let edge = result.branches[0].points[1].tracking_edge.as_ref().unwrap();
    assert_eq!(edge.previous_sample_index, Some(0));
    assert_eq!(edge.skipped_sample_count, 1);
    assert_eq!(edge.score_source.as_str(), "modal_overlap_unweighted_score");
    write_branch_bundle(&temp.path, &result).unwrap();
    let payload: Value = serde_json::from_slice(&std::fs::read(
        temp.path.join("eigen/branches.v2.json")).unwrap()).unwrap();
    assert_eq!(payload["tracking_method"], "overlap_hungarian");
    assert_eq!(payload["overlap_floor"], 0.7);
    assert_eq!(payload["tracking_policy_availability"], "complete");
    assert_eq!(payload["branches"][0]["points"][1]["tracking_edge"],
               serde_json::to_value(edge).unwrap());
    assert_eq!(payload["branches"][0]["points"][1]["raw_mode_index"], 13);
    let legacy: Value = serde_json::from_slice(&std::fs::read(
        temp.path.join("eigen/branches.json")).unwrap()).unwrap();
    for key in ["branches", "tracking_method", "overlap_floor", "frequency_window_hz",
                "tracking_policy_availability"] { assert_eq!(payload[key], legacy[key]); }
    result.branches[0].points[1].tracking_edge = None;
    write_branch_bundle(&temp.path, &result).unwrap();
    for name in ["branches.v2.json", "branches.json"] {
        let partial: Value = serde_json::from_slice(&std::fs::read(
            temp.path.join("eigen").join(name)).unwrap()).unwrap();
        assert_eq!(partial["tracking_policy_availability"], "missing_or_mixed");
        assert!(partial["tracking_method"].is_null());
        assert!(partial["overlap_floor"].is_null());
        assert!(partial["frequency_window_hz"].is_null());
    }
}

#[test]
fn tracked_pair_overlap_is_published_as_confidence_in_json_and_csv() {
    let temp = TempDirGuard::new("tracked-overlap-confidence");
    let mut result = sample_result();
    result.branches.clear();
    result.samples[0].modes[0].reduced_vector = Some(vec![
        Complex64::new(1.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
    ]);
    result.samples[0].modes[0].node_mass_weights = Some(vec![1.0, 1.0]);
    let mut next_sample = result.samples[0].clone();
    next_sample.sample.sample_index = 1;
    next_sample.sample.label = Some("X".to_string());
    next_sample.sample.path_s = 1.0;
    next_sample.modes[0].reduced_vector = Some(vec![
        Complex64::new(0.8, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.6, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
    ]);
    next_sample.modes[0].node_mass_weights = Some(vec![1.0, 1.0]);
    result.samples.push(next_sample);

    let tracking = fullmag_ir::ModeTrackingIR {
        method: fullmag_ir::ModeTrackingMethodIR::OverlapHungarian,
        frequency_window_hz: None,
        overlap_floor: 0.5,
        max_branch_gap: 0,
    };
    crate::eigen::tracking::track_branches(&mut result, Some(&tracking));
    let point = &result.branches[0].points[1];
    assert!((point.overlap_prev.unwrap() - 0.8).abs() < 1.0e-12);
    assert!((point.tracking_confidence - 0.8).abs() < 1.0e-12);
    assert_eq!(
        point.tracking_edge.as_ref().unwrap().score_source.as_str(),
        "modal_overlap_weighted_score"
    );

    write_branch_bundle(&temp.path, &result).expect("tracked branch artifacts should write");
    let branches: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/branches.v2.json"))
            .expect("branch JSON should be readable"),
    )
    .expect("branch JSON should be valid");
    let json_point = &branches["branches"][0]["points"][1];
    assert_eq!(json_point["tracking_confidence"].as_f64(), Some(0.8));
    assert_eq!(json_point["overlap_prev"].as_f64(), Some(0.8));
    assert_eq!(
        json_point["tracking_edge"]["score_source"],
        "modal_overlap_weighted_score"
    );

    let branch_table = std::fs::read_to_string(temp.path.join("eigen/branch_table.csv"))
        .expect("branch table CSV should be readable");
    let lines = branch_table.lines().collect::<Vec<_>>();
    let headers = lines[0].split(',').collect::<Vec<_>>();
    let columns = lines[2].split(',').collect::<Vec<_>>();
    let column = |name: &str| headers.iter().position(|header| *header == name).unwrap();
    assert_eq!(columns[column("tracking_confidence")], "0.800000");
    assert_eq!(columns[column("overlap_prev")], "0.800000");
}

#[test]
fn actual_plan_gamma_is_shared_by_spectra_and_mode_fields() {
    let temp = TempDirGuard::new("actual-gamma");
    let mut result = sample_result();
    result.gamma0_rad_s_per_a_m = 1.7e5;
    write_path_bundle(&temp.path, &result).unwrap();
    write_mode_bundle(&temp.path, &result).unwrap();
    let gamma = result.gamma0_rad_s_per_a_m / crate::MU0;
    for name in ["spectrum.v2.json", "spectrum.v3.json", "path.json"] {
        let payload: Value = serde_json::from_slice(&std::fs::read(
            temp.path.join("eigen").join(name)).unwrap()).unwrap();
        let mode = &payload["samples"][0]["modes"][0];
        assert_eq!(mode["gamma0_rad_s_per_A_m"], result.gamma0_rad_s_per_a_m);
        assert_eq!(mode["gamma_rad_s_T"], gamma);
        assert_eq!(mode["mu0_T_m_per_A"], crate::MU0);
    }
    let payload: Value = serde_json::from_slice(&std::fs::read(
        temp.path.join("eigen/modes/sample_0000/mode_0000.json")).unwrap()).unwrap();
    assert_eq!(payload["gamma0_rad_s_per_A_m"], result.gamma0_rad_s_per_a_m);
    assert_eq!(payload["gamma_rad_s_T"], gamma);
}

#[test]
fn invalid_plan_gamma_cannot_publish_reference_metadata() {
    for gamma0 in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::MAX] {
        let temp = TempDirGuard::new("invalid-gamma");
        let mut result = sample_result_with_k0_kittel_sweep();
        result.gamma0_rad_s_per_a_m = gamma0;
        assert!(write_path_bundle(&temp.path, &result).is_err());
        assert!(write_mode_bundle(&temp.path, &result).is_err());
        assert!(build_kittel_fit_artifact(&result).is_err());
        assert!(!temp.path.join("eigen").exists());
    }
}

#[test]
fn nonreference_gamma_drives_kittel_oracle_and_parameter() {
    for model in ["macrospin_larmor", "thin_film_in_plane"] {
        let mut result = sample_result_with_k0_kittel_sweep();
        result.gamma0_rad_s_per_a_m = 1.7e5;
        let validation = result.k0_kittel_validation.as_mut().unwrap();
        validation.model = model.into();
        validation.material.effective_magnetisation = Some(8e5);
        let fields = validation.samples.iter().map(|sample| sample.bias_field[0]).collect::<Vec<_>>();
        for (index, field) in fields.iter().copied().enumerate() {
            let factor = if model == "macrospin_larmor" { field }
                else { (field*(field+8e5)).sqrt() };
            let frequency = result.gamma0_rad_s_per_a_m * factor / std::f64::consts::TAU;
            result.samples[index].modes[0].frequency_real_hz = frequency;
            result.samples[index].modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU*frequency;
            result.samples[index].modes[0].eigenvalue_imag = std::f64::consts::TAU*frequency;
            result.branches[0].points[index].frequency_real_hz = frequency;
        }
        let fit = build_kittel_fit_artifact(&result).unwrap().unwrap();
        assert_eq!(fit.parameters.iter().find(|param| param.name == "gamma0_rad_s_per_A_m")
                   .unwrap().value, result.gamma0_rad_s_per_a_m);
        for (index, point) in fit.points.iter().enumerate() {
            assert_eq!(point.expected_frequency_hz, result.samples[index].modes[0].frequency_real_hz);
            assert!(point.relative_frequency_error < 1e-12);
        }
    }
}

#[test]
fn kittel_oracle_rejects_nonfinite_frequency_from_finite_inputs() {
    let mut result = sample_result_with_k0_kittel_sweep();
    // gamma0/mu0 is representable, but gamma0 * H0 is not.
    result.gamma0_rad_s_per_a_m = 1e300;
    for sample in &mut result.k0_kittel_validation.as_mut().unwrap().samples {
        sample.bias_field = [1e100, 0.0, 0.0];
    }
    assert!(build_kittel_fit_artifact(&result).is_err());
}

fn artifact_identity() -> FrequencyDomainArtifactIdentity {
    FrequencyDomainArtifactIdentity::try_new(
        "session:test-frequency-domain",
        "run:test-frequency-domain",
        "stage:test-frequency-domain",
        "runtime:test-frequency-domain",
    )
    .expect("test artifact identity should be valid")
}

#[test]
fn artifact_identity_rejects_mutable_aliases() {
    for (session_id, run_id) in [
        ("current", "run:exact"),
        ("session:exact", "current"),
        ("session:exact", "run:current"),
    ] {
        let error = FrequencyDomainArtifactIdentity::try_new(
            session_id,
            run_id,
            "stage:eigenmodes",
            "runtime:exact",
        )
        .expect_err("mutable aliases must not enter durable artifacts");
        assert!(error.to_string().contains("exact identity"));
    }
}
fn sample_result() -> PathSolveResult {
    sample_result_with_solver_model(EigenSolverModel::ReferenceScalarTangent)
}

fn sample_result_with_solver_model(solver_model: EigenSolverModel) -> PathSolveResult {
    PathSolveResult {
        gamma0_rad_s_per_a_m: 2.211e5, // Explicit fixture parameter.
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
                residual_relative_l2: Some(2.5e-10),
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
                consistent_p1_metric: None,
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
                tracking_edge: None,
            }],
        }],
        solver_model,
        notes: vec!["single sample".to_string()],
        include_demag: false,
        dispersion_validation: None,
        k0_kittel_validation: None,
        solver_policy: None,
        dispersion_analytic_reference: None,
        k0_kittel_periodic_airbox_demag: None,
    }
}

#[test]
fn sample_diagnostics_never_fall_back_to_another_sample() {
    let mut result = sample_result();
    result.samples[0].sample.sample_index = 3;
    for entries in [
        serde_json::json!([{ "sample_index": 0, "diagnostics": {"owner": "wrong"} }]),
        serde_json::json!([
            { "sample_index": 0, "diagnostics": {"owner": "wrong"} },
            { "sample_index": 1, "diagnostics": {"owner": "also-wrong"} }
        ]),
        serde_json::json!([{ "diagnostics": {"owner": "unindexed"} }]),
    ] {
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "relax_to_eigen_handoff_sha256": "wrong-root",
            "sample_solver_diagnostics": entries,
        }));
        assert!(sample_native_solver_diagnostics(&result.samples[0]).is_none());
    }
}

#[test]
fn sample_diagnostics_reject_duplicate_or_malformed_identity_records() {
    let mut result = sample_result();
    for entries in [
        serde_json::json!([
            { "sample_index": 0, "diagnostics": {"owner": "first"} },
            { "sample_index": 0, "diagnostics": {"owner": "duplicate"} }
        ]),
        serde_json::json!({"sample_index": 0}),
        serde_json::json!([{ "sample_index": 0, "diagnostics": null }]),
    ] {
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "sample_solver_diagnostics": entries,
        }));
        assert!(sample_native_solver_diagnostics(&result.samples[0]).is_none());
    }
}

#[test]
fn enriched_sample_diagnostics_require_valid_selected_diagnostics() {
    for diagnostics in [serde_json::Value::Null, serde_json::json!([]), serde_json::json!(7)] {
        let root = serde_json::json!({
            "solver_adapter": "native",
            "sample_solver_diagnostics": [{"sample_index": 3, "diagnostics": diagnostics}],
        });
        assert!(native_solver_diagnostics_for_sample(&root, 3).is_none());
    }
    assert!(native_solver_diagnostics_for_sample(&serde_json::Value::Null, 0).is_none());
    assert!(native_solver_diagnostics_for_sample(&serde_json::json!([]), 0).is_none());
}

#[test]
fn native_diagnostics_selector_preserves_local_and_enriched_records() {
    let local = serde_json::json!({"owner": "local"});
    assert_eq!(native_solver_diagnostics_for_sample(&local, 3), Some(&local));
    let enriched = serde_json::json!({
        "solver_adapter": "native",
        "sample_solver_diagnostics": [{"sample_index": 3, "diagnostics": {"owner": "selected"}}],
    });
    assert_eq!(native_solver_diagnostics_for_sample(&enriched, 3), Some(&enriched));
    assert!(native_solver_diagnostics_for_sample(&enriched, 0).is_none());
}

#[test]
fn sample_diagnostics_select_unique_matching_sample() {
    let mut result = sample_result();
    result.samples[0].sample.sample_index = 3;
    result.samples[0].solver_diagnostics = Some(serde_json::json!({
        "sample_solver_diagnostics": [
            { "sample_index": 0, "diagnostics": {"owner": "wrong"} },
            { "sample_index": 3, "diagnostics": {"owner": "selected"} }
        ],
    }));
    assert_eq!(
        sample_native_solver_diagnostics(&result.samples[0]).unwrap()["owner"],
        "selected"
    );
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
        result.gamma0_rad_s_per_a_m,
    );

    assert_eq!(
        summary.relax_to_eigen_handoff_sha256.as_deref(),
        Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
}

fn sample_result_with_modal_overlap_tracking() -> PathSolveResult {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    let node_mass_weights = vec![1.0, 4.0, 9.0];
    result.samples[0].modes[0].reduced_vector = Some(vec![
        Complex64::new(1.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
    ]);
    result.samples[0].modes[0].node_mass_weights = Some(node_mass_weights.clone());
    result.samples[0].modes[0].norm = 1.0;
    result.samples[0].modes[0].mass_norm = Some(1.0);
    result.samples[0].modes[0].lifted_real = Some(vec![
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
    ]);
    result.samples[0].modes[0].lifted_imag = Some(vec![[0.0, 0.0, 0.0]; 3]);
    result.samples[0].modes[0].amplitude = Some(vec![1.0, 0.0, 0.0]);
    result.samples[0].modes[0].phase = Some(vec![0.0, 0.0, 0.0]);

    let mut sample_1 = result.samples[0].clone();
    sample_1.sample.sample_index = 1;
    sample_1.sample.label = Some("X".to_string());
    sample_1.sample.path_s = 10_000_000.0;
    sample_1.sample.k_vector = [10_000_000.0, 0.0, 0.0];
    sample_1.modes[0].frequency_real_hz = 1.25e9;
    sample_1.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * 1.25e9;
    sample_1.modes[0].eigenvalue_imag = std::f64::consts::TAU * 1.25e9;
    sample_1.modes[0].reduced_vector = Some(vec![
        Complex64::new(1.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.375, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
    ]);
    sample_1.modes[0].norm = 1.140625_f64.sqrt();
    sample_1.modes[0].mass_norm = Some(1.25);
    sample_1.modes[0].max_amplitude = 1.0;
    sample_1.modes[0].lifted_real = Some(vec![
        [1.0, 0.0, 0.0],
        [0.375, 0.0, 0.0],
        [0.0, 0.0, 0.0],
    ]);
    sample_1.modes[0].lifted_imag = Some(vec![[0.0, 0.0, 0.0]; 3]);
    sample_1.modes[0].amplitude = Some(vec![1.0, 0.375, 0.0]);
    sample_1.modes[0].phase = Some(vec![0.0, 0.0, 0.0]);
    let mut sample_2 = sample_1.clone();
    sample_2.sample.sample_index = 2;
    sample_2.sample.label = Some("G".to_string());
    sample_2.sample.path_s = 20_000_000.0;
    sample_2.sample.k_vector = [0.0, 0.0, 0.0];
    sample_2.modes[0].frequency_real_hz = 1.5e9;
    sample_2.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * 1.5e9;
    sample_2.modes[0].eigenvalue_imag = std::f64::consts::TAU * 1.5e9;
    sample_2.modes[0].reduced_vector = Some(vec![
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(1.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 0.0),
    ]);
    sample_2.modes[0].norm = 1.0;
    sample_2.modes[0].mass_norm = Some(2.0);
    sample_2.modes[0].max_amplitude = 1.0;
    sample_2.modes[0].lifted_real = Some(vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
    ]);
    sample_2.modes[0].lifted_imag = Some(vec![[0.0, 0.0, 0.0]; 3]);
    sample_2.modes[0].amplitude = Some(vec![0.0, 1.0, 0.0]);
    sample_2.modes[0].phase = Some(vec![0.0, 0.0, 0.0]);
    result.samples.push(sample_1);
    result.samples.push(sample_2);

    let tracking = fullmag_ir::ModeTrackingIR {
        method: fullmag_ir::ModeTrackingMethodIR::OverlapHungarian,
        frequency_window_hz: None,
        overlap_floor: 0.5,
        max_branch_gap: 0,
    };
    result.branches.clear();
    crate::eigen::tracking::track_branches(&mut result, Some(&tracking));
    result.notes = vec!["modal overlap tracking".to_string()];
    result
}

// Keep Cartesian mode payloads, nodal summaries, and mass norms coherent when
// selector tests replace the base Kittel mode. The X component is the same
// fixture frame used by the declared bias-field sweep.
fn set_kittel_fixture_x_mode(
    mode: &mut SingleKModeResult,
    x_components: &[f64],
    node_mass_weights: &[f64],
) {
    assert_eq!(x_components.len(), node_mass_weights.len());
    assert!(node_mass_weights
        .iter()
        .all(|weight| weight.is_finite() && *weight > 0.0));

    let mut reduced_vector = Vec::with_capacity(x_components.len() * 3);
    let mut lifted_real = Vec::with_capacity(x_components.len());
    let mut lifted_imag = Vec::with_capacity(x_components.len());
    let mut amplitude = Vec::with_capacity(x_components.len());
    let mut phase = Vec::with_capacity(x_components.len());
    let mut norm_squared = 0.0;
    let mut mass_norm_squared = 0.0;

    for (&x, &weight) in x_components.iter().zip(node_mass_weights) {
        reduced_vector.extend([
            Complex64::new(x, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        lifted_real.push([x, 0.0, 0.0]);
        lifted_imag.push([0.0, 0.0, 0.0]);
        amplitude.push(x.abs());
        phase.push(if x < 0.0 { std::f64::consts::PI } else { 0.0 });
        norm_squared += x * x;
        mass_norm_squared += weight * x * x;
    }

    mode.reduced_vector = Some(reduced_vector);
    mode.lifted_real = Some(lifted_real);
    mode.lifted_imag = Some(lifted_imag);
    mode.node_mass_weights = Some(node_mass_weights.to_vec());
    mode.amplitude = Some(amplitude.clone());
    mode.phase = Some(phase);
    mode.norm = norm_squared.sqrt();
    mode.mass_norm = Some(mass_norm_squared.sqrt());
    mode.max_amplitude = amplitude.into_iter().fold(0.0_f64, f64::max);
}

fn sample_result_with_k0_kittel_sweep() -> PathSolveResult {
    let mut result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
    let template = result.samples[0].clone();
    let fields_a_per_m = [40_000.0, 80_000.0, 120_000.0];

    result.samples.clear();
    result.branches.clear();

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
        // Synthetic four-node mode data exercise artifact selection only; no
        // FEM convergence or qualified metric is claimed by this fixture.
        let uniform_mode = [
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        sample.modes[0].reduced_vector = Some(uniform_mode.to_vec());
        sample.modes[0].node_mass_weights = Some(vec![1.0; 4]);
        sample.modes[0].norm = 2.0;
        sample.modes[0].mass_norm = Some(2.0);
        sample.modes[0].max_amplitude = 1.0;
        sample.modes[0].lifted_real = Some(vec![[1.0, 0.0, 0.0]; 4]);
        sample.modes[0].lifted_imag = Some(vec![[0.0, 0.0, 0.0]; 4]);
        sample.modes[0].amplitude = Some(vec![1.0; 4]);
        sample.modes[0].phase = Some(vec![0.0; 4]);
        result.samples.push(sample);
    }

    let tracking = fullmag_ir::ModeTrackingIR {
        method: fullmag_ir::ModeTrackingMethodIR::OverlapHungarian,
        frequency_window_hz: None,
        overlap_floor: 0.5,
        max_branch_gap: 0,
    };
    crate::eigen::tracking::track_branches(&mut result, Some(&tracking));
    result.branches[0].label = Some("k0_kittel_uniform_branch".to_string());

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
    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
        .expect("frequency-domain eigen manifest should write");

    let eigen_dir = temp.path.join("eigen");
    let spectrum: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("spectrum.v2.json"))
            .expect("spectrum.v2.json should be written"),
    )
    .expect("spectrum.v2.json should be valid JSON");
    assert_eq!(spectrum["schema_version"], "eigen_spectrum.v2");
    assert_eq!(spectrum["sample_count"], 1);
    assert_eq!(spectrum["samples"][0]["sample_id"], "k-path-sample-0000");
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["mode_id"],
        "sample-0000/mode-0000"
    );
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["mode_field_id"],
        "analysis:eigen:sample-0000:mode-0000"
    );
    assert!(spectrum["samples"][0]["modes"][0]
        .get("mode_field_resource_key")
        .is_none());
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["residual_absolute_l2"],
        1.25e-9
    );
    assert_eq!(
        spectrum["samples"][0]["modes"][0]["residual_relative_l2"],
        2.5e-10
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

    assert!(!spectrum.to_string().contains("/v2/sessions/current"));
    assert!(!spectrum_v3.to_string().contains("/v2/sessions/current"));

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
        branches["branches"][0]["points"][0]["sample_id"],
        "k-path-sample-0000"
    );
    assert_eq!(
        branches["branches"][0]["points"][0]["mode_id"],
        "sample-0000/mode-0000"
    );
    assert_eq!(
        branches["branches"][0]["points"][0]["mode_field_available"],
        true
    );
    assert_eq!(
        branches["branches"][0]["points"][0]["mode_field_id"],
        "analysis:eigen:sample-0000:mode-0000"
    );
    assert!(branches["branches"][0]["points"][0].get("mode_field_resource_key").is_none());

    assert!(!branches.to_string().contains("/v2/sessions/current"));

    let branch_table = std::fs::read_to_string(eigen_dir.join("branch_table.csv"))
        .expect("branch_table.csv should be written");
    assert_eq!(
        branch_table.lines().next(),
        Some("sample_index,sample_id,branch_id,raw_mode_index,mode_id,frequency_real_hz,frequency_imag_hz,tracking_confidence,overlap_prev,mode_field_available,mode_field_id")
    );
    assert!(!branch_table.contains("/v2/sessions/current"));

    let dispersion = std::fs::read_to_string(eigen_dir.join("dispersion.csv"))
        .expect("dispersion.csv should be written");
    let mut dispersion_lines = dispersion.lines();
    let dispersion_header = dispersion_lines
        .next()
        .expect("dispersion.csv should include a header");
    assert_eq!(
            Some(dispersion_header),
            Some(
                "sample_index,sample_id,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,mode_id,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_available,mode_field_id"
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
        dispersion_columns.get(column("sample_id")),
        Some(&"k-path-sample-0000")
    );
    assert_eq!(
        dispersion_columns.get(column("mode_id")),
        Some(&"sample-0000/mode-0000")
    );
    assert_eq!(
        dispersion_columns.get(column("mode_field_available")),
        Some(&"true")
    );
    assert_eq!(
        dispersion_columns.get(column("mode_field_id")),
        Some(&"analysis:eigen:sample-0000:mode-0000")
    );
    assert!(!header_columns.contains(&"mode_field_resource_key"));
    assert!(!dispersion.contains("/v2/sessions/current"));

    let mode: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("modes/sample_0000_mode_0000.json"))
            .expect("flat v2 mode artifact should be written"),
    )
    .expect("mode artifact should be valid JSON");
    assert_eq!(mode["sample_index"], 0);
    assert_eq!(mode["raw_mode_index"], 0);
    assert_eq!(mode["frequency_hz"], 1.0e9);
    assert_eq!(mode["frequency_real_hz"], 1.0e9);
    assert_eq!(mode["residual_absolute_l2"], 1.25e-9);
    assert_eq!(mode["residual_relative_l2"], 2.5e-10);
    assert_eq!(
        mode["mode_field_id"],
        "analysis:eigen:sample-0000:mode-0000"
    );
    assert!(mode.get("mode_field_resource_key").is_none());
    assert!(!mode.to_string().contains("/v2/sessions/current"));
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
    assert_eq!(
        family_manifest["session_id"],
        "session:test-frequency-domain"
    );
    assert_eq!(family_manifest["run_id"], "run:test-frequency-domain");
    assert_eq!(family_manifest["stage_id"], "stage:test-frequency-domain");
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
    assert!(!family_manifest.to_string().contains("/v2/sessions/current/"));
    assert_eq!(family_manifest["resources"]["mode_field_resources"], serde_json::json!([]));
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
fn generic_diagnostics_writer_uses_flags_and_does_not_publish_a_spectrum() {
    let temp = TempDirGuard::new("eigen-diagnostics-v2-flags");
    let result = sample_result();
    let outputs = [fullmag_ir::OutputIR::EigenDiagnostics {
        include_tracking: false,
        include_residuals: true,
        include_overlaps: false,
        include_tangent_leakage: true,
        include_orthogonality: false,
    }];

    write_frequency_domain_eigen_manifest_with_outputs(
        &temp.path,
        &result,
        &artifact_identity(),
        &outputs,
        Some(1),
        None,
    )
    .expect("generic writer should publish requested diagnostics");

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        manifest["artifacts"]["eigen_diagnostics_v2_path"],
        "eigen/diagnostics.v2.json"
    );
    assert_eq!(
        manifest["resources"]["eigen_diagnostics_resource_key"],
        "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2"
    );
    assert!(manifest["artifacts"]["spectrum_v2_path"].is_null());
    assert!(manifest["artifacts"]["mode_metadata_paths"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!temp.path.join("eigen/spectrum.v2.json").exists());

    let diagnostics: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/diagnostics.v2.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(diagnostics["schema_version"], "eigen_diagnostics.v2");
    assert_eq!(diagnostics["solver_model_scope"], "path_orchestrator");
    assert_eq!(diagnostics["solver_model"], "reference_scalar_tangent");
    assert_eq!(diagnostics["sample_count"], 1);
    assert!(diagnostics["basis_transport_policy"].is_null());
    assert!(diagnostics["solver_adapter"].is_null());
    assert_eq!(
        diagnostics["sample_execution_provenance_status"],
        "orchestrator_only_reference"
    );
    assert_eq!(
        diagnostics["sample_execution_provenance"]["samples"][0]["sample_index"],
        0
    );
    assert_eq!(diagnostics["dispersion"]["mode_count"], 1);
    assert_eq!(diagnostics["tracking"]["status"], "not_requested");
    assert_eq!(diagnostics["residuals"]["status"], "available");
    assert_eq!(diagnostics["residuals"]["data"]["records"][0]["residual_absolute_l2"], 1.25e-9);
    assert_eq!(diagnostics["overlaps"]["status"], "not_requested");
    assert_eq!(diagnostics["tangent_leakage"]["status"], "available");
    assert_eq!(diagnostics["tangent_leakage"]["data"]["records"][0]["mean_abs"], 3.0e-12);
    assert_eq!(diagnostics["orthogonality"]["status"], "not_requested");
}

#[test]
fn eigen_artifact_writer_keeps_missing_relative_residual_unavailable() {
    let temp = TempDirGuard::new("eigen-artifacts-missing-relative-residual");
    let mut result = sample_result();
    result.samples[0].modes[0].residual_relative_l2 = None;

    write_path_bundle(&temp.path, &result).expect("path spectrum should write");
    write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
        .expect("frequency-domain eigen manifest should write");

    let eigen_dir = temp.path.join("eigen");
    let spectrum: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("spectrum.v2.json"))
            .expect("spectrum.v2.json should be written"),
    )
    .expect("spectrum.v2.json should be valid JSON");
    assert!(spectrum["samples"][0]["modes"][0]["residual_relative_l2"].is_null());

    let mode: Value = serde_json::from_slice(
        &std::fs::read(eigen_dir.join("modes/sample_0000_mode_0000.json"))
            .expect("flat mode artifact should be written"),
    )
    .expect("flat mode artifact should be valid JSON");
    assert!(mode["residual_relative_l2"].is_null());
}

#[test]
fn path_writer_keeps_bias_namespace_explicit_for_physical_field_sweeps() {
    let temp = TempDirGuard::new("eigen-artifacts-bias-namespace");
    let result = sample_result();

    write_path_bundle_with_sample_namespace(&temp.path, &result, true)
        .expect("field-sweep path bundle should write");

    let spectrum: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/spectrum.v2.json"))
            .expect("spectrum.v2.json should be written"),
    )
    .expect("spectrum.v2.json should be valid JSON");
    assert_eq!(
        spectrum["samples"][0]["sample_id"],
        "bias-field-sample-0000"
    );

    let spectrum_v3: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("eigen/spectrum.v3.json"))
            .expect("spectrum.v3.json should be written"),
    )
    .expect("spectrum.v3.json should be valid JSON");
    assert_eq!(
        spectrum_v3["samples"][0]["sample_id"],
        "bias-field-sample-0000"
    );
}

#[test]
fn eigen_manifest_does_not_publish_dispersion_for_single_free_modes() {
    let temp = TempDirGuard::new("eigen-manifest-free-modes");
    let result = sample_result();

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
        write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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

    for (point, expected_overlap) in result.branches[0]
        .points
        .iter()
        .skip(1)
        .zip([0.8, 0.6])
    {
        let edge = point
            .tracking_edge
            .as_ref()
            .expect("actual tracker should record each pair edge");
        assert_eq!(edge.score_source.as_str(), "modal_overlap_weighted_score");
        assert!((point.overlap_prev.unwrap() - expected_overlap).abs() < 1.0e-12);
    }

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

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
            "sample_index": 0,
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

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
    assert_eq!(summary["status"], "partial");
    assert_eq!(summary["frequency_comparison_status"], "passed");
    assert_eq!(summary["periodic_mode_seam_metrics_complete"], false);
    assert_eq!(summary["qualification"], "NOT VERIFIED");
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
    assert_eq!(kittel_fit["session_id"], "session:test-frequency-domain");
    assert_eq!(kittel_fit["run_id"], "run:test-frequency-domain");
    assert_eq!(kittel_fit["stage_id"], "stage:test-frequency-domain");
    assert_eq!(kittel_fit["runtime_id"], "runtime:test-frequency-domain");
    assert_eq!(kittel_fit["source"]["artifact"], "eigen/spectrum.v2.json");
    assert_eq!(kittel_fit["model"], "macrospin_larmor");
    assert_eq!(kittel_fit["complete"], false);
}

#[test]
fn k0_kittel_relative_residual_is_null_when_any_point_is_missing() {
    let mut result = sample_result_with_k0_kittel_sweep();
    result.samples[1].modes[0].residual_relative_l2 = None;

    let artifacts = k0_kittel_validation_auxiliary_artifacts(&result)
        .expect("Kittel artifacts should preserve unavailable residual metadata");
    let summary = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/summary.v1.json")
        .expect("Kittel summary should be present");
    let summary: Value = serde_json::from_slice(&summary.bytes).expect("summary should be JSON");
    assert!(summary["solver"]["max_eigen_residual_relative"].is_null());
    assert_eq!(summary["status"], "partial");
    assert_eq!(summary["frequency_comparison_status"], "passed");
    assert_eq!(summary["qualification"], "NOT VERIFIED");
    assert!(summary["missing_evidence"]
        .as_array()
        .expect("missing evidence should be an array")
        .iter()
        .any(|item| item.as_str() == Some("per_mode_residual_measurement")));

    let points = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/points.v1.csv")
        .expect("Kittel points should be present");
    let rows = String::from_utf8(points.bytes.clone()).expect("points should be UTF-8");
    let header = rows
        .lines()
        .next()
        .expect("points header should be present");
    let residual_column = header
        .split(',')
        .position(|column| column == "mode_residual_relative")
        .expect("relative residual column should be present");
    let missing_row = rows
        .lines()
        .find(|row| row.split(',').nth(2) == Some("1"))
        .expect("field index 1 row should be present");
    assert_eq!(missing_row.split(',').nth(residual_column), Some(""));
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
    assert_eq!(summary["status"], "partial");
    assert_eq!(summary["frequency_comparison_status"], "passed");
    assert_eq!(summary["periodic_mode_seam_metrics_complete"], false);
    assert_eq!(summary["qualification"], "NOT VERIFIED");
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
        let node_mass_weights = sample_result.modes[0]
            .node_mass_weights
            .clone()
            .expect("Kittel fixture should carry nodal mass weights");
        let mut nonuniform = sample_result.modes[0].clone();
        nonuniform.raw_mode_index = 0;
        nonuniform.frequency_real_hz = expected_frequency;
        nonuniform.angular_frequency_rad_per_s = std::f64::consts::TAU * expected_frequency;
        nonuniform.eigenvalue_imag = std::f64::consts::TAU * expected_frequency;
        set_kittel_fixture_x_mode(
            &mut nonuniform,
            &[1.0, -1.0, 1.0, -1.0],
            &node_mass_weights,
        );

        let mut uniform = sample_result.modes[0].clone();
        uniform.raw_mode_index = 1;
        uniform.frequency_real_hz = expected_frequency * 1.001;
        uniform.angular_frequency_rad_per_s = std::f64::consts::TAU * uniform.frequency_real_hz;
        uniform.eigenvalue_imag = std::f64::consts::TAU * uniform.frequency_real_hz;
        set_kittel_fixture_x_mode(
            &mut uniform,
            &[1.0, 1.0, 1.0, 1.0],
            &node_mass_weights,
        );

        sample_result.modes = vec![nonuniform, uniform];
        let sample_index = sample_result.sample.sample_index;
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 0,
            frequency_real_hz: expected_frequency,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
            tracking_edge: None,
        });
        result.branches[1].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 1,
            frequency_real_hz: expected_frequency * 1.001,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
            tracking_edge: None,
        });
    }

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
        let node_mass_weights = sample_result.modes[0]
            .node_mass_weights
            .clone()
            .expect("Kittel fixture should carry nodal mass weights");
        let mut branch_zero_mode = sample_result.modes[0].clone();
        branch_zero_mode.raw_mode_index = 0;
        branch_zero_mode.frequency_real_hz = expected_frequency * 1.001;
        branch_zero_mode.angular_frequency_rad_per_s =
            std::f64::consts::TAU * branch_zero_mode.frequency_real_hz;
        branch_zero_mode.eigenvalue_imag = branch_zero_mode.angular_frequency_rad_per_s;
        set_kittel_fixture_x_mode(
            &mut branch_zero_mode,
            &[1.0, 1.0, 1.0, 1.0],
            &node_mass_weights,
        );

        let mut analytical_match_mode = sample_result.modes[0].clone();
        analytical_match_mode.raw_mode_index = 1;
        analytical_match_mode.frequency_real_hz = expected_frequency;
        analytical_match_mode.angular_frequency_rad_per_s =
            std::f64::consts::TAU * analytical_match_mode.frequency_real_hz;
        analytical_match_mode.eigenvalue_imag = analytical_match_mode.angular_frequency_rad_per_s;
        set_kittel_fixture_x_mode(
            &mut analytical_match_mode,
            &[1.0, 1.0, 1.0, 1.0],
            &node_mass_weights,
        );

        sample_result.modes = vec![branch_zero_mode, analytical_match_mode];
        let sample_index = sample_result.sample.sample_index;
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 0,
            frequency_real_hz: expected_frequency * 1.001,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
            tracking_edge: None,
        });
        result.branches[1].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 1,
            frequency_real_hz: expected_frequency,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
            tracking_edge: None,
        });
    }

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
        set_kittel_fixture_x_mode(&mut unweighted_uniform, &[0.0, 1.0], &mass_weights);

        let mut mass_weighted_uniform = sample_result.modes[0].clone();
        mass_weighted_uniform.raw_mode_index = 1;
        mass_weighted_uniform.frequency_real_hz = expected_frequency * 1.001;
        mass_weighted_uniform.angular_frequency_rad_per_s =
            std::f64::consts::TAU * mass_weighted_uniform.frequency_real_hz;
        mass_weighted_uniform.eigenvalue_imag =
            std::f64::consts::TAU * mass_weighted_uniform.frequency_real_hz;
        set_kittel_fixture_x_mode(&mut mass_weighted_uniform, &[1.0, -1.0], &mass_weights);

        sample_result.modes = vec![unweighted_uniform, mass_weighted_uniform];
        let sample_index = sample_result.sample.sample_index;
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 0,
            frequency_real_hz: expected_frequency,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
            tracking_edge: None,
        });
        result.branches[1].points.push(TrackedBranchPoint {
            sample_index,
            raw_mode_index: 1,
            frequency_real_hz: expected_frequency * 1.001,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: (sample_index > 0).then_some(1.0),
            tracking_edge: None,
        });
    }

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
    let artifact = build_frequency_domain_field_sweep_artifact(&result, &artifact_identity())
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
    let artifact = build_frequency_domain_field_sweep_artifact(&result, &artifact_identity())
        .expect("field-sweep builder should validate the source")
        .expect("declared physical bias field should produce an artifact");
    assert_eq!(artifact.schema_version, "eigen/field_sweep.v1");
    assert_eq!(artifact.session_id, "session:test-frequency-domain");
    assert_eq!(artifact.run_id, "run:test-frequency-domain");
    assert_eq!(artifact.stage_id, "stage:test-frequency-domain");
    assert_eq!(artifact.runtime_id, "runtime:test-frequency-domain");
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
    assert_eq!(artifact.samples[0].modes[0].mode_field_resource_key, None);
    assert!(!serde_json::to_string(&artifact).unwrap().contains("/v2/sessions/current/"));
    assert_eq!(artifact.samples[0].modes[0].mode_artifact_path.as_deref(),
               Some("eigen/modes/sample_0000/mode_0000.json"));
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

    let artifact = build_frequency_domain_field_sweep_artifact(&result, &artifact_identity())
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

    let artifact = build_frequency_domain_field_sweep_artifact(&result, &artifact_identity())
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

    write_frequency_domain_field_sweep_artifact(&temp.path, &result, &artifact_identity())
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
    assert_eq!(
        topology.mesh_generation_id.as_deref(),
        Some("generation:test")
    );

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
    let artifact = build_frequency_domain_field_sweep_artifact(&result, &artifact_identity())
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
fn kittel_fit_validation_requires_finite_residual_for_each_selected_point() {
    for residual in [None, Some(f64::NAN), Some(-1.0)] {
        let mut result = sample_result_with_k0_kittel_sweep();
        result.samples[1].modes[0].residual_relative_l2 = residual;

        let fit = build_kittel_fit_artifact(&result)
            .expect("diagnostic Kittel fit should remain writable")
            .expect("fixture declares Kittel validation");
        assert_eq!(fit.validation_status, "not_verified");
        assert_eq!(fit.status, ServerArtifactStatus::Partial);
        assert!(!fit.complete);
        assert_eq!(fit.points.len(), 3);
        assert_eq!(fit.points[0].status, ServerArtifactStatus::Complete);
        assert_eq!(fit.points[1].status, ServerArtifactStatus::Partial);
        assert_eq!(fit.points[2].status, ServerArtifactStatus::Complete);
    }

    let complete_result = sample_result_with_k0_kittel_sweep();
    let complete_fit = build_kittel_fit_artifact(&complete_result)
        .expect("complete residual control should build")
        .expect("fixture declares Kittel validation");
    assert_eq!(complete_fit.validation_status, "passed");
    assert!(complete_fit
        .points
        .iter()
        .all(|point| point.status == ServerArtifactStatus::Complete));
}

#[test]
fn kittel_fit_frequency_failure_precedes_unavailable_residual() {
    let mut result = sample_result_with_k0_kittel_sweep();
    result.samples[1].modes[0].frequency_real_hz *= 2.0;
    result.samples[1].modes[0].residual_relative_l2 = None;

    let fit = build_kittel_fit_artifact(&result)
        .expect("frequency failure should remain reportable")
        .expect("fixture declares Kittel validation");
    assert_eq!(fit.validation_status, "failed");
    assert_eq!(fit.points[1].status, ServerArtifactStatus::Partial);
}

#[test]
fn undeclared_kittel_validation_does_not_break_path_writer() {
    let temp = TempDirGuard::new("eigen-artifacts-kittel-validation-optional-off");
    let mut result = sample_result_with_k0_kittel_sweep();
    result.k0_kittel_validation = None;

    write_path_bundle(&temp.path, &result)
        .expect("ordinary path writer should work without optional Kittel validation");
    assert!(!write_kittel_fit_artifact(&temp.path, &result)
        .expect("optional Kittel fit artifact should remain non-failing"));
    assert!(build_kittel_fit_artifact(&result)
        .expect("optional Kittel fit builder should remain non-failing")
        .is_none());
    assert!(k0_kittel_validation_auxiliary_artifacts(&result)
        .expect("optional Kittel summary builder should remain non-failing")
        .is_empty());
    assert!(!temp.path.join("fmr/kittel_fit.v1.json").exists());
}

#[test]
fn eigen_manifest_carries_k0_kittel_validation_contract() {
    let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-validation");
    let result = sample_result_with_k0_kittel_sweep();

    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
    write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
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
    assert_eq!(
        manifest["validation"]["dispersion_reference_model"],
        "kalinikos_slab_n0"
    );
}

#[test]
fn native_modal_manifest_distinguishes_numeric_solve_from_comparison() {
    let temp = TempDirGuard::new("eigen-artifacts-modal-frequency-source");
    for (solver_model, expected_source) in [
        (
            EigenSolverModel::ProductionCpuShiftInvert,
            Some("numeric_modal_solver"),
        ),
        (EigenSolverModel::ReferenceScalarTangent, None),
    ] {
        let mut result = sample_result_with_solver_model(solver_model);
        result.samples[0].sample.k_vector = [1.5e6, 0.0, 0.0];
        result.samples[0].sample.path_s = 1.5e6;
        result.include_demag = true;
        write_frequency_domain_eigen_manifest(&temp.path, &result, &artifact_identity())
            .expect("frequency-domain manifest should write");

        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be written"),
        )
        .expect("frequency-domain manifest should parse");
        assert_eq!(
            manifest["validation"]["dispersion_frequency_source"],
            expected_source.map_or(Value::Null, |source| Value::String(source.to_string()))
        );
        assert!(manifest["validation"]["dispersion_reference_model"].is_null());
    }
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
fn identity_aware_response_entrypoint_preserves_exact_owner_identity() {
    let temp = TempDirGuard::new("response-exact-identity");
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_element(1, 1, 4.0),
        mass: DMatrix::from_element(1, 1, 1.0),
        damping: Some(DMatrix::from_element(1, 1, 0.5)),
    };
    let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
    let identity = artifact_identity();

    solve_and_write_field_driven_response_sweep_bundle_with_identity(
        &temp.path,
        &identity,
        &template,
        &[2.0, 3.0],
        &field_excitation,
        "runner.dense_block_real",
        "dense_block_real_lu",
        "gilbert_linear",
        "local_validation",
    )
    .expect("identity-aware response entrypoint should write its bundle");

    let family_manifest: Value = serde_json::from_slice(
        &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
            .expect("frequency-domain manifest should be written"),
    )
    .expect("frequency-domain manifest should be valid JSON");
    assert_eq!(family_manifest["session_id"], identity.session_id);
    assert_eq!(family_manifest["run_id"], identity.run_id);
    assert_eq!(family_manifest["stage_id"], identity.stage_id);
    assert_eq!(family_manifest["runtime_id"], identity.runtime_id);
}

#[test]
fn identity_aware_response_entrypoint_rejects_mutable_owner_alias() {
    let temp = TempDirGuard::new("response-invalid-identity");
    let template = BlockRealHarmonicTemplate {
        stiffness: DMatrix::from_element(1, 1, 4.0),
        mass: DMatrix::from_element(1, 1, 1.0),
        damping: Some(DMatrix::from_element(1, 1, 0.5)),
    };
    let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
    let invalid_identity = FrequencyDomainArtifactIdentity {
        session_id: "current".to_string(),
        run_id: "run:exact".to_string(),
        stage_id: "stage:response".to_string(),
        runtime_id: "runtime:exact".to_string(),
    };

    let error = solve_and_write_field_driven_response_sweep_bundle_with_identity(
        &temp.path,
        &invalid_identity,
        &template,
        &[2.0],
        &field_excitation,
        "runner.dense_block_real",
        "dense_block_real_lu",
        "gilbert_linear",
        "local_validation",
    )
    .expect_err("mutable identity alias must fail before artifact publication");

    assert!(error.contains("exact identity"));
    assert!(!temp.path.join("frequency_domain/manifest.v1.json").exists());
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
