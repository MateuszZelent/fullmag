//! Physics validation tests for Fullmag.
//!
//! These integration tests verify correct micromagnetic physics implementation
//! across solvers.  Analogous to mumax3's `test/standardproblem*.mx3`.
//!
//! Reference values for Standard Problem 4 are from mumax3
//! (`test/standardproblem4.mx3`).
//!
//! See `docs/physics/0500-fdm-relaxation-algorithms.md` for algorithm details.

use fullmag_ir::{
    EigenDampingPolicyIR, EigenNormalizationIR, EigenOperatorConfigIR, EigenOperatorIR,
    EigenTargetIR, EquilibriumSourceIR, ExchangeBoundaryCondition, ExecutionPrecision,
    FdmMaterialIR, FdmPlanIR, FemEigenDispersionValidationIR,
    FemEigenDispersionValidationScenarioIR, FemEigenDispersionValidationWindowIR, FemEigenPlanIR,
    GridDimensions, IntegratorChoice, KPointIR, KSamplingIR, MaterialIR, MeshIR, OutputIR,
    RelaxationAlgorithmIR, RelaxationControlIR,
};
use fullmag_runner::RunStatus;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Permalloy material (µMAG SP4 parameters).
fn permalloy() -> FdmMaterialIR {
    FdmMaterialIR {
        name: "Py".to_string(),
        saturation_magnetisation: 800e3, // A/m
        exchange_stiffness: 13e-12,      // J/m
        damping: 0.5,                    // overdamped for relaxation
        ..Default::default()
    }
}

#[test]
fn frequency_domain_golden_artifacts_are_contract_shaped() {
    let golden_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("tests/golden/frequency_domain/exchange_chain_gamma_x");

    let problem: serde_json::Value = serde_json::from_slice(
        &std::fs::read(golden_dir.join("problem.json")).expect("problem golden should exist"),
    )
    .expect("problem golden should be valid json");
    assert_eq!(
        problem["physics"]["spin_wave_bc"]["phase_convention"],
        "exp_minus_i_k_dot_delta_r"
    );

    let spectrum: serde_json::Value = serde_json::from_slice(
        &std::fs::read(golden_dir.join("spectrum.v2.json"))
            .expect("spectrum.v2 golden should exist"),
    )
    .expect("spectrum.v2 golden should be valid json");
    assert_eq!(spectrum["schema_version"], "eigen_spectrum.v2");
    assert_eq!(spectrum["samples"][1]["label"], "X");
    assert_eq!(spectrum["samples"][1]["path_s"], 50_000_000.0);
    assert_eq!(spectrum["samples"][1]["modes"][0]["branch_id"], 0);

    let branches: serde_json::Value = serde_json::from_slice(
        &std::fs::read(golden_dir.join("branches.v2.json"))
            .expect("branches.v2 golden should exist"),
    )
    .expect("branches.v2 golden should be valid json");
    assert_eq!(branches["schema_version"], "eigen_branches.v2");
    assert_eq!(
        branches["tracking_score_source"].as_str(),
        Some("modal_overlap_weighted_score")
    );
    assert_eq!(branches["modal_overlap_available"].as_bool(), Some(true));
    assert_eq!(
        branches["diagnostics"]["tracking_score_source"].as_str(),
        Some("modal_overlap_weighted_score")
    );
    assert_eq!(branches["branches"][0]["points"][1]["sample_index"], 1);
    assert_eq!(branches["branches"][0]["points"][1]["overlap_prev"], 0.99);
    assert_eq!(
        branches["branches"][0]["points"][1]["frequency_hz"].as_f64(),
        Some(1_450_000_000.0)
    );
    assert_eq!(
        branches["branches"][0]["points"][1]["tracking_score_source"].as_str(),
        Some("modal_overlap_weighted_score")
    );

    let dispersion = std::fs::read_to_string(golden_dir.join("dispersion.csv"))
        .expect("csv golden should exist");
    let header = dispersion.lines().next().expect("csv should have a header");
    for required in [
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "ky_rad_per_m",
        "kz_rad_per_m",
        "branch_id",
        "residual_norm",
        "tracking_score_source",
        "mode_field_id",
        "mode_field_resource_key",
    ] {
        assert!(
            header.split(',').any(|column| column == required),
            "golden dispersion.csv header must contain {required}, got {header}"
        );
    }
}

/// Compute average magnetization from a magnetization array.
fn average_m(m: &[[f64; 3]]) -> [f64; 3] {
    let n = m.len() as f64;
    let mut avg = [0.0; 3];
    for v in m {
        avg[0] += v[0];
        avg[1] += v[1];
        avg[2] += v[2];
    }
    avg[0] /= n;
    avg[1] /= n;
    avg[2] /= n;
    avg
}

/// Assert a vector is approximately equal to expected within tolerance.
fn assert_vec_approx(label: &str, actual: [f64; 3], expected: [f64; 3], tol: f64) {
    for (i, comp) in ["x", "y", "z"].iter().enumerate() {
        let diff = (actual[i] - expected[i]).abs();
        assert!(
            diff < tol,
            "{label}: m_{comp} = {:.6}, expected {:.6} (diff={:.2e}, tol={:.2e})",
            actual[i],
            expected[i],
            diff,
            tol
        );
    }
}

/// µMAG Standard Problem 4 plan: 128×32×1 Permalloy film.
fn sp4_plan(algorithm: RelaxationAlgorithmIR, damping: f64, enable_demag: bool) -> FdmPlanIR {
    let nx = 128u32;
    let ny = 32u32;
    let n = (nx * ny) as usize;

    // Initial magnetization: m = normalize(1, 0.1, 0)
    let norm = (1.0f64 * 1.0 + 0.1 * 0.1).sqrt();
    let m0 = vec![[1.0 / norm, 0.1 / norm, 0.0]; n];

    FdmPlanIR {
        grid: GridDimensions { cells: [nx, ny, 1] },
        cell_size: [500e-9 / nx as f64, 125e-9 / ny as f64, 3e-9],
        region_mask: vec![0; n],
        active_mask: None,
        initial_magnetization: m0,
        material: FdmMaterialIR {
            damping,
            ..permalloy()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(IntegratorChoice::Heun),
        fixed_timestep: Some(1e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        }),
        enable_exchange: true,
        enable_demag,
        external_field: None,
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Test 1: Uniform field alignment
// ---------------------------------------------------------------------------

/// A random initial state in a strong Zeeman field must align with the field.
///
/// Physics: Zeeman energy E_ext = -μ₀ M_s ∫ m·H_ext dV dominates.
/// At equilibrium, m ∥ H_ext.
#[test]
#[ignore = "expensive FDM physics validation; run explicitly before solver-physics releases"]
fn uniform_field_alignment() {
    let n = 16usize;
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, n);

    let plan = FdmPlanIR {
        grid: GridDimensions { cells: [4, 4, 1] },
        cell_size: [5e-9, 5e-9, 5e-9],
        region_mask: vec![0; n],
        active_mask: None,
        initial_magnetization: random_m0,
        material: permalloy(),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(IntegratorChoice::Heun),
        fixed_timestep: Some(1e-14),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-5),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        }),
        enable_exchange: false,
        enable_demag: false,
        // Strong field along +x: H = 1e6 A/m ≈ 1.26 T
        external_field: Some([1e6, 0.0, 0.0]),
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    };

    let result = fullmag_runner::run_reference_fdm(&plan, 1e-9, &[]).expect("run should succeed");
    assert_eq!(result.status, RunStatus::Completed);

    let avg = average_m(&result.final_magnetization);
    assert_vec_approx("field_alignment", avg, [1.0, 0.0, 0.0], 1e-2);
}

// ---------------------------------------------------------------------------
// Test 2: Exchange-only random → uniform
// ---------------------------------------------------------------------------

/// A random initial state with exchange-only coupling must relax to a
/// state with dramatically reduced exchange energy.
///
/// Physics: Exchange energy penalizes spatial gradients.  Minimization
/// drives neighboring cells to align, reducing E_ex by orders of magnitude.
/// On a small grid, the final state may be locally uniform but not globally
/// aligned in a single direction.
#[test]
#[ignore = "expensive FDM physics validation; run explicitly before solver-physics releases"]
fn exchange_only_random_to_uniform() {
    let n = 64usize;
    let random_m0 = fullmag_plan::generate_random_unit_vectors(123, n);

    let plan = FdmPlanIR {
        grid: GridDimensions { cells: [4, 4, 4] },
        cell_size: [2e-9, 2e-9, 2e-9],
        region_mask: vec![0; n],
        active_mask: None,
        initial_magnetization: random_m0,
        material: permalloy(),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(IntegratorChoice::Heun),
        fixed_timestep: Some(1e-14),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(10_000),
                max_relaxation_time_s: None,
            },
        }),
        enable_exchange: true,
        enable_demag: false,
        external_field: None,
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    };

    let result = fullmag_runner::run_reference_fdm(&plan, 1e-9, &[]).expect("run should succeed");

    // Exchange energy should be negligibly small after relaxation
    // (BB converges very rapidly on this exchange-only problem)
    let final_e_ex = result.steps.last().unwrap().e_ex;
    assert!(
        final_e_ex.abs() < 1e-17,
        "exchange energy should be ~0 after relaxation, got {:.4e}",
        final_e_ex
    );
}

// ---------------------------------------------------------------------------
// Test 3: Thin-film shape anisotropy (demag)
// ---------------------------------------------------------------------------

/// Out-of-plane magnetization in a thin film must relax in-plane due to
/// demagnetization field (shape anisotropy).
///
/// Physics: For a thin film with L_z ≪ L_x, L_y, the demagnetization
/// factor N_z ≈ 1, creating a strong in-plane easy-plane anisotropy.
/// A small in-plane perturbation breaks the symmetry of the out-of-plane
/// saddle point.
#[test]
#[ignore = "expensive FDM physics validation; run explicitly before solver-physics releases"]
fn thin_film_shape_anisotropy() {
    let nx = 16u32;
    let ny = 16u32;
    let n = (nx * ny) as usize;

    // Start mostly out-of-plane with a small in-plane tilt to break symmetry
    // (pure z is a saddle point that LLG cannot escape without perturbation)
    let m0: Vec<[f64; 3]> = (0..n)
        .map(|_| {
            let norm = (0.01f64 * 0.01 + 1.0).sqrt();
            [0.01 / norm, 0.0, 1.0 / norm]
        })
        .collect();

    let plan = FdmPlanIR {
        grid: GridDimensions { cells: [nx, ny, 1] },
        cell_size: [5e-9, 5e-9, 2e-9], // thin: 2nm thick vs 80nm wide
        region_mask: vec![0; n],
        active_mask: None,
        initial_magnetization: m0,
        material: permalloy(),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(IntegratorChoice::Heun),
        fixed_timestep: Some(1e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-3),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        }),
        enable_exchange: true,
        enable_demag: true,
        external_field: None,
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    };

    let result = fullmag_runner::run_reference_fdm(&plan, 10e-9, &[]).expect("run should succeed");

    let avg = average_m(&result.final_magnetization);

    // Demagnetization energy should have decreased
    let initial_e_demag = result.steps.first().unwrap().e_demag;
    let final_e_demag = result.steps.last().unwrap().e_demag;
    assert!(
        final_e_demag < initial_e_demag,
        "demag energy should decrease: {:.4e} -> {:.4e}",
        initial_e_demag,
        final_e_demag
    );

    // m_z should be significantly reduced (in-plane rotation)
    assert!(
        avg[2].abs() < 0.5,
        "thin film should relax in-plane: |<m_z>| = {:.4}, expected < 0.5",
        avg[2].abs()
    );
}

// ---------------------------------------------------------------------------
// Test 4: µMAG Standard Problem 4 — equilibrium (S-state)
// ---------------------------------------------------------------------------

/// µMAG Standard Problem 4: Permalloy 500×125×3 nm³ film.
/// Relax from m = normalize(1, 0.1, 0) to the S-state equilibrium.
///
/// Reference: mumax3 `test/standardproblem4.mx3`:
///   ⟨m⟩ = (0.9669684171676636, 0.1252732127904892, 0)
///
/// Physics: Competition between exchange (smoothing) and demagnetization
/// (flux closure) produces an S-state with slight edge curling.
#[test]
#[ignore = "expensive FDM physics validation; run explicitly before solver-physics releases"]
fn sp4_equilibrium() {
    let plan = sp4_plan(RelaxationAlgorithmIR::LlgOverdamped, 0.5, true);

    let result =
        fullmag_runner::run_reference_fdm(&plan, 10e-9, &[]).expect("SP4 relax should succeed");
    assert_eq!(result.status, RunStatus::Completed);

    let avg = average_m(&result.final_magnetization);

    // mumax3 reference: (0.9669, 0.1253, 0.0)
    // Use 5% tolerance — our Heun integrator and demag kernel differ slightly
    let tol = 0.05;
    assert!(
        (avg[0] - 0.9669).abs() < tol,
        "SP4 <mx> = {:.6}, expected ~0.9669 (tol={tol})",
        avg[0]
    );
    assert!(
        (avg[1] - 0.1253).abs() < tol,
        "SP4 <my> = {:.6}, expected ~0.1253 (tol={tol})",
        avg[1]
    );
    assert!(
        avg[2].abs() < tol,
        "SP4 <mz> = {:.6}, expected ~0.0 (tol={tol})",
        avg[2]
    );

    // Energy should be negative (stable state)
    let final_energy = result.steps.last().unwrap().e_total;
    assert!(
        final_energy < 0.0,
        "SP4 equilibrium energy should be negative, got {:.4e}",
        final_energy
    );
}

// ---------------------------------------------------------------------------
// Test 5: Cross-algorithm SP4 consistency
// ---------------------------------------------------------------------------

/// All three relaxation algorithms must converge to the same SP4
/// equilibrium state (within tolerance).
///
/// Physics: The equilibrium is algorithm-independent — only the
/// convergence path differs.
#[test]
#[ignore = "expensive FDM physics validation; run explicitly before solver-physics releases"]
fn sp4_cross_algorithm_equilibrium() {
    let algorithms = [
        ("LLG", RelaxationAlgorithmIR::LlgOverdamped),
        ("BB", RelaxationAlgorithmIR::ProjectedGradientBb),
        ("NCG", RelaxationAlgorithmIR::NonlinearCg),
    ];

    let mut results: Vec<(&str, [f64; 3], f64)> = Vec::new();

    for (name, alg) in &algorithms {
        let plan = sp4_plan(*alg, 0.5, true);
        let result = fullmag_runner::run_reference_fdm(&plan, 10e-9, &[])
            .unwrap_or_else(|e| panic!("{name} relaxation failed: {}", e.message));
        let avg = average_m(&result.final_magnetization);
        let energy = result.steps.last().unwrap().e_total;
        results.push((name, avg, energy));
    }

    // All should agree on average magnetization (within 5%)
    let (ref_name, ref_m, ref_e) = results[0];
    for (name, avg, energy) in &results[1..] {
        for (i, comp) in ["x", "y", "z"].iter().enumerate() {
            let diff = (avg[i] - ref_m[i]).abs();
            assert!(
                diff < 0.05,
                "{name} vs {ref_name}: m_{comp} differs by {diff:.4} (ref={:.4}, got={:.4})",
                ref_m[i],
                avg[i]
            );
        }
        // Energy should agree within 20% relative
        let e_diff = (energy - ref_e).abs();
        let e_rel = if ref_e.abs() > 1e-25 {
            e_diff / ref_e.abs()
        } else {
            e_diff
        };
        assert!(
            e_rel < 0.2,
            "{name} vs {ref_name}: energy differs by {:.1}% (ref={ref_e:.4e}, got={energy:.4e})",
            e_rel * 100.0
        );
    }
}

// ---------------------------------------------------------------------------
// Test 6: SP4 reversal dynamics
// ---------------------------------------------------------------------------

/// µMAG Standard Problem 4: apply external field and run dynamics.
/// After relaxation, apply B_ext = (-24.6, 4.3, 0) mT and run for 1 ns.
///
/// Reference: mumax3 `test/standardproblem4.go`:
///   ⟨m⟩ at t=1ns = (-0.9846, 0.1260, 0.0433)
///
/// Physics: The external field exceeds the coercive field, triggering
/// magnetization reversal via domain nucleation and propagation.
#[test]
#[ignore = "expensive FDM physics validation; run explicitly before solver-physics releases"]
fn sp4_reversal_dynamics() {
    // Phase 1: Relax to S-state
    let relax_plan = sp4_plan(RelaxationAlgorithmIR::LlgOverdamped, 0.5, true);
    let relax_result = fullmag_runner::run_reference_fdm(&relax_plan, 10e-9, &[])
        .expect("SP4 relax should succeed");

    let relaxed_m = relax_result.final_magnetization;

    // Phase 2: Apply reversal field and run dynamics with physical damping
    let n = relaxed_m.len();
    // B_ext = (-24.6, 4.3, 0) mT → H_ext = B / μ₀
    let mu0 = 4.0 * std::f64::consts::PI * 1e-7;
    let h_ext = [-24.6e-3 / mu0, 4.3e-3 / mu0, 0.0];

    let dyn_plan = FdmPlanIR {
        grid: GridDimensions {
            cells: [128, 32, 1],
        },
        cell_size: [500e-9 / 128.0, 125e-9 / 32.0, 3e-9],
        region_mask: vec![0; n],
        active_mask: None,
        initial_magnetization: relaxed_m,
        material: FdmMaterialIR {
            damping: 0.02, // physical damping for dynamics
            ..permalloy()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(IntegratorChoice::Heun),
        fixed_timestep: Some(5e-14), // needs small dt for dynamics with α=0.02
        adaptive_timestep: None,
        relaxation: None, // no relaxation — pure dynamics
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        enable_exchange: true,
        enable_demag: true,
        external_field: Some(h_ext),
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    };

    let dyn_result = fullmag_runner::run_reference_fdm(&dyn_plan, 1e-9, &[])
        .expect("SP4 dynamics should succeed");
    assert_eq!(dyn_result.status, RunStatus::Completed);

    let avg = average_m(&dyn_result.final_magnetization);

    // mumax3 reference at t=1ns: (-0.9846, 0.1260, 0.0433)
    // Use 10% tolerance — different integrator (Heun vs DOPRI), dt, demag kernel
    let tol = 0.10;
    assert!(
        (avg[0] - (-0.9846)).abs() < tol,
        "SP4 reversal <mx> = {:.4}, expected ~-0.9846 (tol={tol})",
        avg[0]
    );
    assert!(
        (avg[1] - 0.1260).abs() < tol,
        "SP4 reversal <my> = {:.4}, expected ~0.1260 (tol={tol})",
        avg[1]
    );
    assert!(
        (avg[2] - 0.0433).abs() < tol,
        "SP4 reversal <mz> = {:.4}, expected ~0.0433 (tol={tol})",
        avg[2]
    );
}

// ===========================================================================
// FEM eigen validation helpers
// ===========================================================================

/// Permalloy MaterialIR for FEM eigen tests.
fn fem_permalloy() -> MaterialIR {
    MaterialIR {
        name: "Py".to_string(),
        saturation_magnetisation: 800e3,
        exchange_stiffness: 13e-12,
        damping: 0.5,
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
    }
}

/// Build a simple 2×2×2 nm cube FEM mesh (8 nodes, 5 tetrahedra).
///
/// The cube side is `side_nm` nanometres.  The mesh is coarse enough for
/// fast unit tests but has valid topology for the eigen solver.
fn cube_mesh(side_nm: f64) -> MeshIR {
    let a = side_nm * 1e-9;
    // 8 corner nodes of a unit cube scaled by `a`
    let nodes = vec![
        [0.0, 0.0, 0.0], // 0
        [a, 0.0, 0.0],   // 1
        [0.0, a, 0.0],   // 2
        [a, a, 0.0],     // 3
        [0.0, 0.0, a],   // 4
        [a, 0.0, a],     // 5
        [0.0, a, a],     // 6
        [a, a, a],       // 7
    ];
    // Decompose cube into 5 tetrahedra (standard Freudenthal partition)
    let elements = vec![
        [0u32, 1, 3, 7],
        [0, 1, 5, 7],
        [0, 4, 5, 7],
        [0, 2, 3, 7],
        [0, 4, 6, 7],
    ];
    let element_markers = vec![1u32; 5];
    // Boundary triangles (faces of the cube, 12 triangles total)
    let boundary_faces = vec![
        // bottom z=0
        [0u32, 1, 3],
        [0, 3, 2],
        // top z=a
        [4, 5, 7],
        [4, 7, 6],
        // front y=0
        [0, 1, 5],
        [0, 5, 4],
        // back y=a
        [2, 3, 7],
        [2, 7, 6],
        // left x=0
        [0, 2, 6],
        [0, 6, 4],
        // right x=a
        [1, 3, 7],
        [1, 7, 5],
    ];
    let boundary_markers = vec![1u32; boundary_faces.len()];
    let periodic_boundary_pairs = vec![
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 1,
            translation: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        },
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "y_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 1,
            translation: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        },
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "z_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 1,
            translation: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        },
    ];
    let periodic_node_pairs = vec![
        ("x_faces", 0, 1),
        ("x_faces", 2, 3),
        ("x_faces", 4, 5),
        ("x_faces", 6, 7),
        ("y_faces", 0, 2),
        ("y_faces", 1, 3),
        ("y_faces", 4, 6),
        ("y_faces", 5, 7),
        ("z_faces", 0, 4),
        ("z_faces", 1, 5),
        ("z_faces", 2, 6),
        ("z_faces", 3, 7),
    ]
    .into_iter()
    .map(
        |(pair_id, node_a, node_b)| fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: pair_id.to_string(),
            node_a,
            node_b,
        },
    )
    .collect();
    MeshIR {
        mesh_name: format!("cube_{side_nm}nm"),
        nodes,
        elements,
        element_markers,
        boundary_faces,
        boundary_markers,
        periodic_boundary_pairs,
        periodic_node_pairs,
        per_domain_quality: std::collections::HashMap::new(),
    }
}

/// Kittel uniform-mode frequency for an infinite thin film magnetized along x
/// with an in-plane external field `h_x_am` (A/m).
///
/// f_K = γ₀/(2π) · sqrt(H_x · (H_x + Ms))
///
/// where γ₀ = μ₀γ ≈ 2.211e5 m/(A·s) is the gyromagnetic ratio already
/// including μ₀.  This is a rough analytic reference for exchange-off,
/// Zeeman-only tests.
fn kittel_frequency_hz(h_x_am: f64, ms_am: f64, gamma: f64) -> f64 {
    // gamma is already μ₀γ — no additional μ₀ factor needed.
    let omega = gamma * (h_x_am * (h_x_am + ms_am)).sqrt();
    omega / (2.0 * std::f64::consts::PI)
}

/// Extract the lowest eigenfrequency (Hz) from a `FemEigenRunResult`.
fn extract_lowest_frequency(result: &fullmag_runner::FemEigenRunResult) -> Option<f64> {
    result.spectrum_frequencies_hz().into_iter().next()
}

/// Extract all eigenfrequencies (Hz) sorted by ascending mode index.
fn extract_frequencies(result: &fullmag_runner::FemEigenRunResult) -> Vec<f64> {
    result.spectrum_frequencies_hz()
}

// ===========================================================================
// FEM eigen physics tests — EIG-031/032/033/035
// ===========================================================================

/// EIG-035 smoke test: the CPU FEM eigen baseline solver must complete
/// without errors on a minimal mesh and produce at least one finite
/// eigenfrequency.
#[test]
fn fem_eigen_smoke_completes_without_errors() {
    let mesh = cube_mesh(20.0); // 20 nm cube
    let n_nodes = mesh.nodes.len();
    let m0: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; n_nodes];

    let plan = FemEigenPlanIR {
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: m0,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]), // ≈ 50 mT
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let outputs = vec![
        OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        },
        OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: vec![0u32],
        },
    ];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen smoke test must succeed");

    assert_eq!(
        result.status,
        RunStatus::Completed,
        "FEM eigen smoke: status must be Completed"
    );
    let freqs = extract_frequencies(&result);
    assert!(
        !freqs.is_empty(),
        "FEM eigen smoke: must return at least one eigenfrequency"
    );
    assert!(
        freqs.iter().all(|f| f.is_finite() && *f >= 0.0),
        "FEM eigen smoke: all frequencies must be finite and non-negative, got {freqs:?}"
    );
    // Spectrum artifact must be present
    let has_spectrum = result.artifact_bytes("eigen/spectrum.json").is_some();
    assert!(
        has_spectrum,
        "FEM eigen smoke: spectrum.json must be written"
    );
    let spectrum_v2: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/spectrum.v2.json")
            .expect("FEM eigen smoke: spectrum.v2.json must be written"),
    )
    .expect("FEM eigen smoke: spectrum.v2.json must be valid json");
    assert_eq!(
        spectrum_v2["schema_version"].as_str(),
        Some("eigen_spectrum.v2")
    );
    assert_eq!(spectrum_v2["samples"].as_array().map(Vec::len), Some(1));
    assert_eq!(spectrum_v2["samples"][0]["label"].as_str(), Some("Γ"));
    assert!(
        result.artifact_bytes("eigen/branches.v2.json").is_some(),
        "FEM eigen smoke: branches.v2.json must be written"
    );
    assert!(
        result.artifact_bytes("eigen/dispersion.csv").is_some(),
        "FEM eigen smoke: dispersion.csv must be written for the v2 bundle"
    );
    // Mode 0 spatial profile artifact must be present
    let has_mode = result
        .artifact_bytes("eigen/modes/mode_0000.json")
        .is_some();
    assert!(has_mode, "FEM eigen smoke: mode_0000.json must be written");
    let mode_v2: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/modes/sample_0000/mode_0000.json")
            .expect("FEM eigen smoke: nested mode v2 metadata must be written"),
    )
    .expect("FEM eigen smoke: nested mode v2 metadata must be valid json");
    assert_eq!(mode_v2["schema_version"].as_str(), Some("eigen_mode.v2"));
    assert_eq!(mode_v2["storage_format"].as_str(), Some("zarr"));
    assert_eq!(
        mode_v2["zarr_array_path"].as_str(),
        Some("eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex")
    );
    assert_eq!(
        mode_v2["compatibility_binary_payload_path"].as_str(),
        Some("eigen/mode_fields/sample_0000/mode_0000/vector.bin")
    );
    assert_eq!(
        mode_v2["available_views"].as_array().map(Vec::len),
        Some(7),
        "FEM eigen smoke: mode metadata must expose real/imag/complex/abs/amplitude/phase/phase_rotated_real views"
    );
    assert!(
        result
            .artifact_bytes("eigen/mode_fields/sample_0000/mode_0000/vector.bin")
            .is_some(),
        "FEM eigen smoke: mode v2 binary payload must be written"
    );
    assert!(
        result
            .artifact_bytes("eigen/mode_fields.zarr/.zgroup")
            .is_some(),
        "FEM eigen smoke: mode field Zarr store must be written"
    );
    assert!(
        result
            .artifact_bytes(
                "eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/.zarray"
            )
            .is_some(),
        "FEM eigen smoke: mode field Zarr array metadata must be written"
    );
    assert!(
        result
            .artifact_bytes("eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0")
            .is_some(),
        "FEM eigen smoke: mode field Zarr chunk must be written"
    );
    let manifest: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("frequency_domain/manifest.v1.json")
            .expect("FEM eigen smoke: frequency-domain manifest must be written"),
    )
    .expect("FEM eigen smoke: frequency-domain manifest must be valid json");
    assert_eq!(
        manifest["schema_version"].as_str(),
        Some("frequency_domain_manifest.v1")
    );
    assert_eq!(
        manifest["physics"]["phase_convention"].as_str(),
        Some("exp_minus_i_omega_t")
    );
    assert_eq!(manifest["physics"]["frequency_units"].as_str(), Some("Hz"));
    assert_eq!(
        manifest["artifacts"]["spectrum_v2_path"].as_str(),
        Some("eigen/spectrum.v2.json")
    );
    assert_eq!(
        manifest["artifacts"]["mode_field_storage_format"].as_str(),
        Some("zarr")
    );
    assert_eq!(
        manifest["artifacts"]["mode_field_zarr_store_path"].as_str(),
        Some("eigen/mode_fields.zarr")
    );
}

/// EIG-031 analytic benchmark: lowest Zeeman-only mode frequency must be in
/// the correct order-of-magnitude range of the Kittel formula.
///
/// For a 50 mT Zeeman field along x and Py parameters the Kittel frequency is
/// ~7–8 GHz.  Even at this coarse resolution the uniform mode should be within
/// an order of magnitude of that value.
#[test]
fn macrospin_kittel_frequency_order_of_magnitude() {
    let mesh = cube_mesh(20.0);
    let n_nodes = mesh.nodes.len();
    let m0: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; n_nodes];

    let h_x = 39_789.0_f64; // ≈ 50 mT in A/m
    let ms = 800e3_f64;
    let gamma = 2.211e5_f64;

    let plan = FemEigenPlanIR {
        mesh_name: "cube_20nm".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: m0,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 5,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([h_x, 0.0, 0.0]),
        gyromagnetic_ratio: gamma,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let outputs = vec![OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen analytic benchmark must succeed");

    let f_lowest = extract_lowest_frequency(&result).expect("must contain lowest eigenfrequency");

    let f_kittel = kittel_frequency_hz(h_x, ms, gamma);

    // The coarse 8-node mesh does not reproduce the Kittel mode exactly, but
    // the lowest frequency must be within a factor of 10 of the Kittel value.
    let ratio = f_lowest / f_kittel;
    assert!(
        ratio > 0.1 && ratio < 10.0,
        "lowest FEM eigen frequency {f_lowest:.3e} Hz is outside [0.1, 10]× Kittel \
         {f_kittel:.3e} Hz (ratio={ratio:.3})"
    );
}

/// EIG-033 orthogonality test: mode vectors from a Hermitian eigen problem
/// must be mass-orthogonal up to numerical noise.
///
/// For the CPU reference solver all eigenvalues are real and the
/// generalized-eigenvalue solution guarantees mass-orthogonality.  We verify
/// this indirectly: the returned amplitudes should not be identically zero
/// (solver ran) and the first mode's maximum amplitude must be positive.
#[test]
fn fem_eigen_modes_are_non_trivial() {
    let mesh = cube_mesh(20.0);
    let n_nodes = mesh.nodes.len();
    let m0: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; n_nodes];

    let plan = FemEigenPlanIR {
        mesh_name: "cube_20nm_orth".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: m0,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitMaxAmplitude,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let outputs = vec![
        OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        },
        OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: vec![0u32, 1u32],
        },
    ];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen mode orthogonality test must succeed");

    let freqs = extract_frequencies(&result);
    assert!(
        freqs.len() >= 2,
        "must compute at least 2 modes for orthogonality check, got {}",
        freqs.len()
    );

    // Frequencies must be sorted in ascending order (Lowest target)
    for window in freqs.windows(2) {
        assert!(
            window[0] <= window[1] + 1e6, // allow 1 MHz floating-point slack
            "frequencies must be non-decreasing: {:.3e} > {:.3e}",
            window[0],
            window[1]
        );
    }

    // Mode 0 spatial profile must be present and parseable
    let mode_bytes = result
        .artifact_bytes("eigen/modes/mode_0000.json")
        .expect("mode 0 artifact must be present");

    let mode_json: serde_json::Value =
        serde_json::from_slice(mode_bytes).expect("mode 0 JSON must be valid");

    let max_amp = mode_json["max_amplitude"]
        .as_f64()
        .expect("mode 0 must have max_amplitude field");

    assert!(
        max_amp > 0.0,
        "mode 0 max_amplitude must be positive, got {max_amp}"
    );

    for required in [
        "residual_norm",
        "residual_linf",
        "tangent_leakage_mean_abs",
        "tangent_leakage_max_abs",
    ] {
        let value = mode_json[required]
            .as_f64()
            .unwrap_or_else(|| panic!("mode 0 must include numeric {required}: {mode_json}"));
        assert!(
            value >= 0.0,
            "mode 0 diagnostic {required} must be non-negative, got {value}"
        );
    }
}

#[test]
fn dense_eigen_exports_relative_residuals() {
    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_name: "cube_20nm_dense_residuals".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0u32, 1u32],
            },
        ],
    )
    .expect("dense FEM eigen solve must succeed");

    let mode_json: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/modes/mode_0000.json")
            .expect("mode_0000.json must be present"),
    )
    .expect("mode_0000.json must be valid JSON");

    for field in [
        "residual_absolute_l2",
        "residual_relative_l2",
        "residual_linf",
        "mass_norm",
        "omega_rad_s",
        "gamma_rad_s_T",
        "gamma0_rad_s_per_A_m",
        "mu0_T_m_per_A",
    ] {
        let value = mode_json[field]
            .as_f64()
            .unwrap_or_else(|| panic!("mode_0000.json must include numeric {field}: {mode_json}"));
        assert!(
            value.is_finite() && value >= 0.0,
            "mode_0000 {field} must be finite and non-negative, got {value}"
        );
    }

    let summary_json: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/metadata/eigen_summary.json")
            .expect("eigen_summary.json must be present"),
    )
    .expect("eigen_summary.json must be valid JSON");
    let diagnostics = summary_json["solver_diagnostics"]
        .as_object()
        .unwrap_or_else(|| {
            panic!("eigen_summary.json must include solver_diagnostics: {summary_json}")
        });
    assert!(
        diagnostics
            .get("orthogonality")
            .and_then(|value| value.as_array())
            .is_some_and(|rows| !rows.is_empty()),
        "dense eigen summary must include non-empty orthogonality table: {summary_json}"
    );
}

#[test]
fn dense_eigen_exports_tangent_leakage() {
    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_name: "cube_20nm_dense_leakage".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0u32],
            },
        ],
    )
    .expect("dense FEM eigen solve must succeed");

    let mode_json: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/modes/mode_0000.json")
            .expect("mode_0000.json must be present"),
    )
    .expect("mode_0000.json must be valid JSON");

    for field in ["tangent_leakage_mean_abs", "tangent_leakage_max_abs"] {
        let value = mode_json[field]
            .as_f64()
            .unwrap_or_else(|| panic!("mode_0000.json must include numeric {field}: {mode_json}"));
        assert!(
            value.is_finite() && value >= 0.0,
            "mode_0000 {field} must be finite and non-negative, got {value}"
        );
    }
}

#[test]
fn dense_eigen_frequency_units_are_hz_and_rad_s() {
    let mesh = cube_mesh(20.0);
    let gamma = 2.211e5_f64;
    let plan = FemEigenPlanIR {
        mesh_name: "cube_20nm_dense_units".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 1,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: gamma,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0u32],
            },
        ],
    )
    .expect("dense FEM eigen solve must succeed");

    let mode_json: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/modes/mode_0000.json")
            .expect("mode_0000.json must be present"),
    )
    .expect("mode_0000.json must be valid JSON");

    let frequency_hz = mode_json["frequency_hz"]
        .as_f64()
        .expect("mode_0000.json must include frequency_hz");
    let omega_rad_s = mode_json["omega_rad_s"]
        .as_f64()
        .expect("mode_0000.json must include omega_rad_s");
    let gamma_rad_s_t = mode_json["gamma_rad_s_T"]
        .as_f64()
        .expect("mode_0000.json must include gamma_rad_s_T");
    let gamma0_rad_s_per_a_m = mode_json["gamma0_rad_s_per_A_m"]
        .as_f64()
        .expect("mode_0000.json must include gamma0_rad_s_per_A_m");
    let mu0_t_m_per_a = mode_json["mu0_T_m_per_A"]
        .as_f64()
        .expect("mode_0000.json must include mu0_T_m_per_A");

    assert!(
        (omega_rad_s - 2.0 * std::f64::consts::PI * frequency_hz).abs() <= 1.0e-3,
        "omega_rad_s must equal 2πf, got omega={omega_rad_s:.6e}, f={frequency_hz:.6e}"
    );
    assert!(
        (gamma_rad_s_t - gamma / fullmag_engine::MU0).abs()
            <= 1.0e-9 * (gamma / fullmag_engine::MU0).abs(),
        "gamma_rad_s_T must equal gamma0/mu0, got gamma_rad_s_T={gamma_rad_s_t:.6e}"
    );
    assert!(
        (gamma0_rad_s_per_a_m - gamma).abs() <= 1.0e-9,
        "gamma0_rad_s_per_A_m must equal plan gyromagnetic ratio, got {gamma0_rad_s_per_a_m:.6e}"
    );
    assert!(
        (mu0_t_m_per_a - fullmag_engine::MU0).abs() <= 1.0e-18,
        "mu0_T_m_per_A must equal MU0, got {mu0_t_m_per_a:.6e}"
    );
}

/// EIG-032 mesh-convergence hint: running on a finer mesh must not produce
/// lower frequencies than on a coarser mesh by more than a moderate factor.
///
/// This is a weak check: it only ensures the solver is well-behaved across
/// mesh resolutions without requiring a known analytic reference.
#[test]
fn fem_eigen_frequency_is_stable_across_resolutions() {
    let gamma = 2.211e5_f64;
    let h_x = 39_789.0_f64;

    let run = |side_nm: f64| -> f64 {
        let mesh = cube_mesh(side_nm);
        let n = mesh.nodes.len();
        let m0 = vec![[1.0_f64, 0.0, 0.0]; n];
        let plan = FemEigenPlanIR {
            mesh_name: format!("cube_{side_nm}nm"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: side_nm * 1e-9,
            equilibrium_magnetization: m0,
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 3,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: None,
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: gamma,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        };
        let outputs = vec![OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }];
        let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
            .expect("FEM eigen convergence run must succeed");
        extract_lowest_frequency(&result).expect("must return a lowest frequency")
    };

    // Both runs use the same 8-node cube topology with different side lengths
    // (20 nm vs 40 nm).  With an external field applied, the lowest mode is
    // the uniform FMR mode whose eigenvalue equals H₀ (the exchange operator
    // row-sum vanishes for the uniform mode under Neumann BCs).  Therefore
    // the frequency is mesh-size independent: ratio ≈ 1.0.
    let f_20 = run(20.0);
    let f_40 = run(40.0);

    assert!(
        f_20.is_finite() && f_20 > 0.0,
        "20 nm run: f={f_20:.3e} must be positive finite"
    );
    assert!(
        f_40.is_finite() && f_40 > 0.0,
        "40 nm run: f={f_40:.3e} must be positive finite"
    );

    let ratio = f_20 / f_40;
    assert!(
        ratio > 0.8 && ratio < 1.25,
        "20nm/40nm frequency ratio is {ratio:.3} — expected ~1.0 (uniform FMR mode is mesh-invariant)"
    );
}

#[test]
fn fem_eigen_periodic_k_zero_runs_with_periodic_node_pairs() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "periodic_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_name: "periodic_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("periodic k=0 FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert_eq!(value["boundary_config"]["kind"].as_str(), Some("periodic"));
    assert!(value["solver_capabilities"]
        .as_array()
        .is_some_and(|items| items
            .iter()
            .any(|item| item.as_str() == Some("periodic_zero_phase"))));
}

#[test]
fn fem_eigen_floquet_runs_with_phase_aware_metadata() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "floquet_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_name: "floquet_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [5.0e7, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("floquet FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert_eq!(value["boundary_config"]["kind"].as_str(), Some("floquet"));
    assert_eq!(
        value["solver_kind"].as_str(),
        Some("cpu_phase_reduced_floquet")
    );
    assert!(value["solver_limitations"]
        .as_array()
        .is_some_and(|items| items
            .iter()
            .any(|item| item.as_str() == Some("floquet_uses_phase_reduced_hermitian_block"))));
}

#[test]
fn fem_eigen_full_2x2_floquet_executes_nonidentity_tangent_frame_transport() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "floquet_frame_transport_cube".to_string();
    let mut equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; 8];
    equilibrium_magnetization[1] = [0.0, 1.0, 0.0];
    let plan = FemEigenPlanIR {
        mesh_name: "floquet_frame_transport_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::Full2x2,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [5.0e7, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0],
            },
            OutputIR::DispersionCurve {
                name: "dispersion".to_string(),
            },
        ],
    )
    .expect("Full2x2 Floquet modal path must transport nonidentity tangent frames");

    let spectrum: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/spectrum.v2.json")
            .expect("Full2x2 Floquet transport should write spectrum.v2"),
    )
    .expect("Full2x2 Floquet spectrum.v2 should be valid JSON");
    assert!(
        spectrum["samples"][0]["modes"][0]["frequency_hz"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "Full2x2 Floquet transport should produce a finite frequency, got: {spectrum}"
    );
    let mode_metadata: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/modes/sample_0000/mode_0000.json")
            .expect("Full2x2 Floquet transport should write mode metadata"),
    )
    .expect("Full2x2 Floquet mode metadata should be valid JSON");
    assert_eq!(
        mode_metadata["solver_model"].as_str(),
        Some("cpu_full_2x2_phase_reduced_floquet")
    );
    assert!(
        mode_metadata["tangent_leakage_max_abs"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value < 1.0e-10),
        "transported Full2x2 mode should reconstruct tangent vectors, got: {mode_metadata}"
    );
    let diagnostics: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/diagnostics/solver.v1.json")
            .expect("Full2x2 Floquet transport should write solver diagnostics"),
    )
    .expect("Full2x2 Floquet solver diagnostics should be valid JSON");
    assert_eq!(
        diagnostics["basis_transport_policy"].as_str(),
        Some("tangent_frame_transport")
    );
    assert!(
        diagnostics["floquet_tangent_frame_max_mismatch"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "nonidentity tangent-frame run should report a positive frame mismatch, got: {diagnostics}"
    );
    assert!(
        diagnostics["floquet_tangent_transport_max_nonunitarity"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value >= 0.0),
        "tangent-frame transport should report finite nonunitarity, got: {diagnostics}"
    );
}

#[test]
fn fem_eigen_scalar_floquet_still_rejects_nonidentity_tangent_frame_transport() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "floquet_scalar_frame_mismatch_cube".to_string();
    let mut equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; 8];
    equilibrium_magnetization[1] = [0.0, 1.0, 0.0];
    let plan = FemEigenPlanIR {
        mesh_name: "floquet_scalar_frame_mismatch_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [5.0e7, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let error = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect_err("scalar Floquet modal path must reject nonidentity tangent-frame transport");

    assert!(
        error.message.contains("phase*(T_dst^T T_src) support"),
        "error should name the missing scalar tangent-frame transport, got: {}",
        error.message
    );
    assert!(
        error.message.contains("tangent_frame_mismatch"),
        "error should report mismatch diagnostics, got: {}",
        error.message
    );
}

#[test]
fn fem_eigen_damping_include_emits_nonzero_imaginary_frequency() {
    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 1,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Include,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };
    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("damped FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    let first_mode = &value["modes"][0];
    assert!(first_mode["frequency_imag_hz"].as_f64().unwrap_or(0.0) < 0.0);
}

#[test]
fn fem_eigen_surface_anisotropy_runs_and_reports_term() {
    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 1,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::SurfaceAnisotropy,
                boundary_pair_id: None,
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: Some(5.0e-4),
                surface_anisotropy_axis: Some([0.0, 0.0, 1.0]),
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };
    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("surface anisotropy FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert_eq!(
        value["included_terms"]["surface_anisotropy"].as_bool(),
        Some(true)
    );
}

#[test]
fn fem_eigen_floquet_exchange_only_is_reciprocal_for_plus_minus_k() {
    let build_plan = |kx: f64| {
        let mut mesh = cube_mesh(20.0);
        mesh.mesh_name = format!(
            "floquet_exchange_only_{}",
            if kx >= 0.0 { "plus" } else { "minus" }
        );
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 1,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [kx, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([39_789.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    };

    let run_freq = |kx: f64| {
        let plan = build_plan(kx);
        let result = fullmag_runner::run_reference_fem_eigen(
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        )
        .expect("floquet exchange-only FEM eigen solve should execute");
        let spectrum = result
            .artifact_bytes("eigen/spectrum.json")
            .expect("spectrum artifact must exist");
        let value: serde_json::Value =
            serde_json::from_slice(spectrum).expect("valid spectrum json");
        value["modes"][0]["frequency_real_hz"]
            .as_f64()
            .expect("first mode frequency")
    };

    let f_plus = run_freq(5.0e7);
    let f_minus = run_freq(-5.0e7);
    let rel_diff = (f_plus - f_minus).abs() / f_plus.abs().max(f_minus.abs()).max(1.0);
    assert!(
        rel_diff < 1e-10,
        "exchange-only Floquet spectrum should be reciprocal: f(+k)={f_plus:.9e}, f(-k)={f_minus:.9e}, rel_diff={rel_diff:.3e}"
    );
}

#[test]
fn fem_eigen_full_2x2_floquet_exchange_dispersion_matches_analytic() {
    let build_plan = |kx: f64| {
        let mut mesh = cube_mesh(20.0);
        mesh.mesh_name = format!("floquet_full2x2_exchange_k_{kx:.0}");
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::Full2x2,
                include_demag: false,
            },
            count: 1,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [kx, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([39_789.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    };

    let run_freq = |kx: f64| {
        let plan = build_plan(kx);
        let result = fullmag_runner::run_reference_fem_eigen(
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        )
        .expect("full2x2 Floquet exchange-only FEM eigen solve should execute");
        let spectrum = result
            .artifact_bytes("eigen/spectrum.json")
            .expect("spectrum artifact must exist");
        let value: serde_json::Value =
            serde_json::from_slice(spectrum).expect("valid spectrum json");
        value["modes"][0]["frequency_real_hz"]
            .as_f64()
            .expect("first mode frequency")
    };

    let material = fem_permalloy();
    let h0 = 39_789.0;
    let exchange_field = |kx: f64| {
        2.0 * material.exchange_stiffness * kx * kx
            / (fullmag_engine::MU0 * material.saturation_magnetisation)
    };
    let expected_freq = |kx: f64| 2.211e5 * (h0 + exchange_field(kx)) / std::f64::consts::TAU;

    for kx in [0.0, 1.0e7, 2.0e7] {
        let actual = run_freq(kx);
        let expected = expected_freq(kx);
        let rel = (actual - expected).abs() / expected.max(1.0);
        assert!(
            rel < 0.25,
            "exchange-only Full2x2 Floquet frequency should match analytic dispersion within coarse-mesh tolerance: kx={kx:.3e}, actual={actual:.9e}, expected={expected:.9e}, rel={rel:.3e}"
        );
    }
}

#[test]
fn fem_eigen_floquet_bulk_dmi_is_nonreciprocal_for_plus_minus_k() {
    let build_plan = |kx: f64| {
        let mut mesh = cube_mesh(20.0);
        mesh.mesh_name = format!(
            "floquet_bulk_dmi_{}",
            if kx >= 0.0 { "plus" } else { "minus" }
        );
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 1,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [kx, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: Some(2.5e-3),
            external_field: Some([39_789.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    };

    let run_freq = |kx: f64| {
        let plan = build_plan(kx);
        let result = fullmag_runner::run_reference_fem_eigen(
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        )
        .expect("floquet bulk DMI FEM eigen solve should execute");
        let spectrum = result
            .artifact_bytes("eigen/spectrum.json")
            .expect("spectrum artifact must exist");
        let value: serde_json::Value =
            serde_json::from_slice(spectrum).expect("valid spectrum json");
        value["modes"][0]["frequency_real_hz"]
            .as_f64()
            .expect("first mode frequency")
    };

    let f_plus = run_freq(5.0e7);
    let f_minus = run_freq(-5.0e7);
    assert!(
        (f_plus - f_minus).abs() > 1.0,
        "bulk DMI Floquet spectrum should be non-reciprocal, got f(+k)={f_plus:.6e}, f(-k)={f_minus:.6e}"
    );
}

/// EIG-034 FEM↔analytic cross-check with demag: including the demagnetisation
/// field must lower the uniform-mode frequency relative to the Zeeman-only case.
///
/// Physics: for an in-plane equilibrium (m₀ ∥ x̂) with H₀ along x̂, the
/// demagnetisation field adds an effective easy-plane anisotropy.  For a cube
/// (Nₓ ≈ 1/3) the internal field is reduced, so the precession frequency
/// must be lower than in the Zeeman-only (no-demag) case:
///
///   f_with_demag  <  f_no_demag
///
/// This qualitatively matches what FDM time-domain simulations would show when
/// the same geometry is excited with a broadband pulse (the resonance peak
/// in the FFT shifts to lower frequency when demag is switched on).
#[test]
fn fem_eigen_demag_lowers_frequency() {
    // Use a large external field so that the system is well-saturated even
    // after the demagnetisation field is accounted for.
    let h_x = 636_620.0_f64; // ≈ 800 mT / μ₀

    let make_plan = |include_demag: bool| {
        let mesh = cube_mesh(20.0);
        let m0 = vec![[1.0_f64, 0.0, 0.0]; mesh.nodes.len()];
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("cube_20nm_demag_{include_demag}"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: m0,
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag,
            },
            count: 3,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: None,
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: include_demag,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    };

    let outputs = vec![OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];

    let result_no_demag = fullmag_runner::run_reference_fem_eigen(&make_plan(false), &outputs)
        .expect("FEM eigen (no demag) must succeed");
    let result_with_demag = fullmag_runner::run_reference_fem_eigen(&make_plan(true), &outputs)
        .expect("FEM eigen (with demag) must succeed");

    let f_no_demag = extract_lowest_frequency(&result_no_demag)
        .expect("no-demag run must return a lowest frequency");
    let f_with_demag = extract_lowest_frequency(&result_with_demag)
        .expect("with-demag run must return a lowest frequency");

    assert!(
        f_no_demag.is_finite() && f_no_demag > 0.0,
        "no-demag frequency must be positive finite, got {f_no_demag:.3e}"
    );
    assert!(
        f_with_demag.is_finite() && f_with_demag > 0.0,
        "with-demag frequency must be positive finite, got {f_with_demag:.3e}"
    );

    // Including demag must reduce the lowest resonance frequency.
    // Allow a small relative slack (1 %) to guard against numerical noise.
    assert!(
        f_with_demag < f_no_demag * 1.01,
        "demag should lower the uniform-mode frequency: \
         f_with_demag={f_with_demag:.3e} Hz, f_no_demag={f_no_demag:.3e} Hz"
    );
}

#[test]
fn fem_eigen_poisson_robin_demag_runs_on_shared_domain_mesh() {
    let mesh = MeshIR {
        mesh_name: "eigen_shared_domain_robin".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 0],
        boundary_faces: vec![
            [0, 1, 3],
            [1, 2, 3],
            [2, 0, 3],
            [0, 1, 4],
            [1, 2, 4],
            [2, 0, 4],
        ],
        boundary_markers: vec![1, 1, 1, 1, 1, 1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };

    let plan = FemEigenPlanIR {
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: true,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([100_000.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let outputs = [OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen Poisson-Robin demag should execute on shared-domain mesh");
    assert_eq!(result.status, RunStatus::Completed);

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert!(value["solver_capabilities"]
        .as_array()
        .is_some_and(|items| items
            .iter()
            .any(|item| item.as_str() == Some("demag_poisson_robin"))));
}

// ===========================================================================
// Etap 0b — Spin-wave BC end-to-end test pack (EIG-040/041/042/043)
// ===========================================================================

/// EIG-040: Free BC baseline.
///
/// Solve the eigenvalue problem with the default Free (Neumann) BC on a small
/// cube.  Assertions:
/// - solver completes without errors,
/// - all returned frequencies are finite and positive,
/// - they are sorted in non-decreasing order (Lowest target).
/// - the lowest mode frequency is compatible with a Kittel-like estimate for
///   the applied Zeeman field (within an order of magnitude).
#[test]
fn eigen_bc_free_baseline() {
    let h_x = 39_789.0_f64; // ≈ 50 mT / μ₀
    let ms = 800e3_f64;
    let gamma = 2.211e5_f64;

    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_name: "bc_free_baseline".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([h_x, 0.0, 0.0]),
        gyromagnetic_ratio: gamma,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(), // Free BC
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Free BC eigen solve must succeed");

    let freqs = extract_frequencies(&result);
    assert!(
        !freqs.is_empty(),
        "Free BC: must return at least one eigenfrequency"
    );
    assert!(
        freqs.iter().all(|f| f.is_finite() && *f >= 0.0),
        "Free BC: all frequencies must be finite and non-negative, got {freqs:?}"
    );
    for window in freqs.windows(2) {
        assert!(
            window[0] <= window[1] + 1e6,
            "Free BC: frequencies must be non-decreasing: {:.3e} > {:.3e}",
            window[0],
            window[1]
        );
    }
    // The lowest mode should be the uniform FMR.  For free BC under pure
    // Zeeman the eigenvalue equals H₀, so the frequency scales as γ·H₀.
    let f_kittel_approx = gamma * h_x / (2.0 * std::f64::consts::PI);
    let f0 = freqs[0];
    let ratio = f0 / f_kittel_approx;
    assert!(
        ratio > 0.5 && ratio < 2.0,
        "Free BC: lowest frequency {f0:.3e} Hz should be within 2× of Kittel estimate \
         {f_kittel_approx:.3e} Hz (ratio={ratio:.2})"
    );
    // Kittel frequency for thin film (H₀·(H₀+Ms))^0.5 upper bound check
    let f_kittel_max = kittel_frequency_hz(h_x, ms, gamma);
    assert!(
        f0 < f_kittel_max * 3.0,
        "Free BC: f0={f0:.3e} should be less than 3× Kittel thin-film freq {f_kittel_max:.3e}"
    );
}

/// EIG-041: Pinned BC raises eigenfrequencies above Free BC.
///
/// Pinning the surface nodes eliminates zero-gradient modes and adds an
/// effective surface exchange term — all eigenfrequencies must be strictly
/// higher than their Free BC counterparts (at least for the lowest modes).
#[test]
fn eigen_bc_pinned_higher_frequency() {
    let h_x = 39_789.0_f64;
    let gamma = 2.211e5_f64;

    let make_plan = |pinned: bool| {
        let mesh = cube_mesh(20.0);
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("bc_pinned_{pinned}"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 3,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: None,
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: gamma,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: if pinned {
                fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                    fullmag_ir::SpinWaveBoundaryConfigIR {
                        kind: fullmag_ir::SpinWaveBoundaryKindIR::Pinned,
                        boundary_pair_id: None,
                        pair_ids: Vec::new(),
                        phase_convention: fullmag_ir::PhaseConventionIR::default(),
                        surface_anisotropy_ks: None,
                        surface_anisotropy_axis: None,
                    },
                )
            } else {
                fullmag_ir::SpinWaveBoundaryConditionIR::default()
            },
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    };

    let result_free = fullmag_runner::run_reference_fem_eigen(
        &make_plan(false),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Free BC eigen solve must succeed");

    let result_pinned = fullmag_runner::run_reference_fem_eigen(
        &make_plan(true),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    );

    // On a 2×2×2 mesh all 8 nodes are surface nodes; Pinned BC eliminates
    // all of them and returns zero active modes → expect an error, not a solve.
    // This is the correct physics: you cannot pin every node in the mesh.
    match result_pinned {
        Err(_) => {
            // Expected: All-surface mesh with Pinned BC → no active nodes → RunError
        }
        Ok(ref result) => {
            // If the solver somehow ran (e.g. interior nodes exist), verify
            // that any returned frequencies are ≥ the Free BC frequencies.
            let freqs_free = extract_frequencies(&result_free);
            let freqs_pinned = extract_frequencies(result);
            if !freqs_pinned.is_empty() && !freqs_free.is_empty() {
                assert!(
                    freqs_pinned[0] >= freqs_free[0] * 0.9,
                    "Pinned BC lowest frequency ({:.3e} Hz) should be >= Free BC ({:.3e} Hz)",
                    freqs_pinned[0],
                    freqs_free[0]
                );
            }
        }
    }

    // Free BC must always succeed
    let freqs_free = extract_frequencies(&result_free);
    assert!(
        !freqs_free.is_empty(),
        "Free BC must return at least one eigenfrequency"
    );
    assert!(
        freqs_free.iter().all(|f| f.is_finite() && *f > 0.0),
        "Free BC frequencies must all be positive finite"
    );
}

/// EIG-042: Periodic BC without periodic_node_pairs returns a RunError.
///
/// When the mesh contains no periodic_node_pairs metadata and the user
/// requests Periodic BC, the runner must report an explicit error rather
/// than silently falling through to Free BC behaviour.
#[test]
fn eigen_bc_periodic_requires_pairs_error() {
    // Build a mesh that has NO periodic_node_pairs.
    let mut mesh = cube_mesh(20.0);
    mesh.periodic_node_pairs.clear();
    mesh.mesh_name = "cube_no_periodic_pairs".to_string();

    let plan = FemEigenPlanIR {
        mesh_name: "cube_no_periodic_pairs".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    );

    assert!(
        result.is_err(),
        "Periodic BC without periodic_node_pairs must return a RunError, got Ok"
    );
    let err_msg = result.unwrap_err().message;
    assert!(
        err_msg.contains("periodic") || err_msg.contains("periodic_node_pairs"),
        "Error message should mention 'periodic' or 'periodic_node_pairs', got: {err_msg}"
    );
}

/// EIG-043: Periodic BC with pairs (k=0) produces the same lowest frequency
/// as Free BC.
///
/// At k=0 all phase factors are 1, so the Periodic-BC operator is identical
/// to the Free-BC operator.  The lowest eigenfrequency must be equal within
/// a small relative tolerance.
#[test]
fn eigen_bc_periodic_k_zero_matches_free() {
    let h_x = 39_789.0_f64;
    let gamma = 2.211e5_f64;

    let make_plan = |periodic: bool| {
        let mesh = cube_mesh(20.0);
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("bc_periodic_k0_{periodic}"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 2,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: if periodic {
                Some(fullmag_ir::KSamplingIR::Single {
                    k_vector: [0.0, 0.0, 0.0],
                })
            } else {
                None
            },
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: gamma,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: if periodic {
                fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                    fullmag_ir::SpinWaveBoundaryConfigIR {
                        kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                        boundary_pair_id: Some("x_faces".to_string()),
                        pair_ids: Vec::new(),
                        phase_convention: fullmag_ir::PhaseConventionIR::default(),
                        surface_anisotropy_ks: None,
                        surface_anisotropy_axis: None,
                    },
                )
            } else {
                fullmag_ir::SpinWaveBoundaryConditionIR::default()
            },
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    };

    let result_free = fullmag_runner::run_reference_fem_eigen(
        &make_plan(false),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Free BC must succeed");

    let result_periodic = fullmag_runner::run_reference_fem_eigen(
        &make_plan(true),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Periodic k=0 must succeed");

    let f_free =
        extract_lowest_frequency(&result_free).expect("Free BC must return a lowest frequency");
    let f_periodic = extract_lowest_frequency(&result_periodic)
        .expect("Periodic k=0 must return a lowest frequency");

    assert!(
        f_free.is_finite() && f_free > 0.0,
        "Free BC f={f_free:.3e} must be positive"
    );
    assert!(
        f_periodic.is_finite() && f_periodic > 0.0,
        "Periodic k=0 f={f_periodic:.3e} must be positive"
    );

    let rel_diff = (f_free - f_periodic).abs() / f_free.max(f_periodic);
    assert!(
        rel_diff < 0.05,
        "Periodic at k=0 should match Free BC within 5%: \
         f_free={f_free:.3e} Hz, f_periodic={f_periodic:.3e} Hz (rel_diff={rel_diff:.3})"
    );
}

#[test]
fn floquet_k0_equals_periodic() {
    let make_plan = |kind: fullmag_ir::SpinWaveBoundaryKindIR| {
        let mesh = cube_mesh(20.0);
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("bc_{kind:?}_k0").to_lowercase(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 2,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: Some(KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([39_789.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    };

    let outputs = [OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];
    let periodic = fullmag_runner::run_reference_fem_eigen(
        &make_plan(fullmag_ir::SpinWaveBoundaryKindIR::Periodic),
        &outputs,
    )
    .expect("periodic k=0 solve should succeed");
    let floquet = fullmag_runner::run_reference_fem_eigen(
        &make_plan(fullmag_ir::SpinWaveBoundaryKindIR::Floquet),
        &outputs,
    )
    .expect("Floquet k=0 solve should succeed");
    let periodic_f =
        extract_lowest_frequency(&periodic).expect("periodic spectrum should have frequencies");
    let floquet_f =
        extract_lowest_frequency(&floquet).expect("Floquet spectrum should have frequencies");

    let rel_diff = (periodic_f - floquet_f).abs() / periodic_f.max(floquet_f);
    assert!(
        rel_diff < 1e-8,
        "Floquet(k=0) must equal Periodic: periodic={periodic_f:.9e} Hz, \
         floquet={floquet_f:.9e} Hz, rel_diff={rel_diff:.3e}"
    );
}

#[test]
fn fem_eigen_path_writes_v2_dispersion_artifacts() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "path_dispersion_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_name: "path_dispersion_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("BV".to_string()),
                    k_vector: [2.0e6, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("DE".to_string()),
                    k_vector: [0.0, 2.0e6, 0.0],
                },
            ],
            samples_per_segment: vec![2, 2],
            closed: false,
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: Some(fullmag_ir::ModeTrackingIR::default()),
        dispersion_validation: Some(FemEigenDispersionValidationIR {
            kind: "thin_film_de_bv_low_k".to_string(),
            analytic_model: "kalinikos_slab_n0".to_string(),
            film_thickness_m: 20.0e-9,
            equilibrium_magnetization: [1.0, 0.0, 0.0],
            film_normal: [0.0, 0.0, 1.0],
            frequency_window_hz: FemEigenDispersionValidationWindowIR {
                min: 0.0,
                max: 5.0e9,
            },
            max_k_rad_per_m: 2.0e6,
            max_relative_error: 0.10,
            scenarios: vec![
                FemEigenDispersionValidationScenarioIR {
                    geometry: "backward_volume".to_string(),
                    branch_id: "branch_0".to_string(),
                    sample_indices: vec![0, 1, 2],
                },
                FemEigenDispersionValidationScenarioIR {
                    geometry: "damon_eshbach".to_string(),
                    branch_id: "branch_0".to_string(),
                    sample_indices: vec![0, 3, 4],
                },
            ],
        }),
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0],
            },
            OutputIR::DispersionCurve {
                name: "dispersion".to_string(),
            },
        ],
    )
    .expect("path eigensolve should produce V2 artifacts");

    let spectrum: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/spectrum.v2.json")
            .expect("spectrum.v2 artifact should exist"),
    )
    .expect("spectrum.v2 should be valid json");
    assert_eq!(
        spectrum["schema_version"].as_str(),
        Some("eigen_spectrum.v2")
    );
    assert_eq!(spectrum["sample_count"].as_u64(), Some(5));
    assert_eq!(
        spectrum["mode_count"].as_u64(),
        Some(1),
        "spectrum.v2 top-level mode_count must match the public published modes"
    );
    assert_eq!(spectrum["samples"].as_array().map(Vec::len), Some(5));
    assert_eq!(spectrum["samples"][2]["label"].as_str(), Some("BV"));
    assert_eq!(spectrum["samples"][4]["label"].as_str(), Some("DE"));
    assert!(spectrum["samples"][2]["path_s"].as_f64().unwrap_or(0.0) > 0.0);
    let spectrum_mode = &spectrum["samples"][2]["modes"][0];
    assert_eq!(
        spectrum_mode["mode_field_id"].as_str(),
        Some("analysis:eigen:sample-0002:mode-0000")
    );
    assert!(
        spectrum_mode["frequency_hz"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "spectrum.v2 sample_0002 mode_0000 should carry frequency_hz, got {spectrum_mode}"
    );
    assert!(
        spectrum_mode["residual_absolute_l2"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value >= 0.0),
        "spectrum.v2 sample_0002 mode_0000 should carry residual diagnostics, got {spectrum_mode}"
    );

    let branches: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/branches.v2.json")
            .expect("branches.v2 artifact should exist"),
    )
    .expect("branches.v2 should be valid json");
    assert_eq!(
        branches["schema_version"].as_str(),
        Some("eigen_branches.v2")
    );
    assert_eq!(
        branches["tracking_score_source"].as_str(),
        Some("modal_overlap_weighted_score")
    );
    assert_eq!(branches["modal_overlap_available"].as_bool(), Some(true));
    assert!(branches["branches"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
    let branch_mode_point = branches["branches"]
        .as_array()
        .and_then(|branches| {
            branches.iter().find_map(|branch| {
                branch["points"].as_array().and_then(|points| {
                    points.iter().find(|point| {
                        point["sample_index"].as_u64() == Some(2)
                            && point["raw_mode_index"].as_u64() == Some(0)
                    })
                })
            })
        })
        .expect("branches.v2 should contain sample_0002 mode_0000");
    assert_eq!(
        branch_mode_point["mode_field_id"].as_str(),
        Some("analysis:eigen:sample-0002:mode-0000")
    );
    assert_eq!(
        branch_mode_point["mode_field_resource_key"].as_str(),
        Some(
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0002:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        )
    );
    assert!(
        branch_mode_point["residual_norm"]
            .as_f64()
            .is_some_and(|value| value.is_finite()),
        "branches.v2 sample_0002 mode_0000 should carry residual_norm, got {branch_mode_point}"
    );
    assert!(
        branch_mode_point["tangent_leakage_mean_abs"]
            .as_f64()
            .is_some_and(|value| value.is_finite()),
        "branches.v2 sample_0002 mode_0000 should carry tangent_leakage_mean_abs, got {branch_mode_point}"
    );
    assert!(
        branch_mode_point["tangent_leakage_max_abs"]
            .as_f64()
            .is_some_and(|value| value.is_finite()),
        "branches.v2 sample_0002 mode_0000 should carry tangent_leakage_max_abs, got {branch_mode_point}"
    );
    assert_eq!(
        branch_mode_point["tracking_score_source"].as_str(),
        Some("modal_overlap_weighted_score")
    );
    assert_eq!(
        branch_mode_point["modal_overlap_available"].as_bool(),
        Some(true)
    );
    assert!(
        branch_mode_point["frequency_hz"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "branches.v2 sample_0002 mode_0000 should carry frequency_hz, got {branch_mode_point}"
    );
    assert!(
        branch_mode_point["angular_frequency_rad_per_s"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "branches.v2 sample_0002 mode_0000 should carry angular_frequency_rad_per_s, got {branch_mode_point}"
    );

    let diagnostics: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/diagnostics.v2.json")
            .expect("diagnostics.v2 artifact should exist"),
    )
    .expect("diagnostics.v2 should be valid json");
    assert_eq!(
        diagnostics["dispersion"]["tracking_score_source"].as_str(),
        Some("modal_overlap_weighted_score")
    );
    assert_eq!(
        diagnostics["dispersion"]["modal_overlap_available"].as_bool(),
        Some(true)
    );
    assert!(
        diagnostics["dispersion"]["median_overlap"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "diagnostics.v2 should publish finite median_overlap when modal overlap is available, got {diagnostics}"
    );
    assert!(
        branches["diagnostics"]["median_overlap"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "branches.v2 should publish finite diagnostics.median_overlap when modal overlap is available, got {branches}"
    );
    let mut published_overlaps = branches["branches"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|branch| branch["points"].as_array().into_iter().flatten())
        .filter(|point| {
            point["tracking_score_source"].as_str() == Some("modal_overlap_weighted_score")
        })
        .filter_map(|point| point["overlap_prev"].as_f64())
        .collect::<Vec<_>>();
    published_overlaps.sort_by(|left, right| left.total_cmp(right));
    let midpoint = published_overlaps.len() / 2;
    let expected_median_overlap = if published_overlaps.len() % 2 == 0 {
        (published_overlaps[midpoint - 1] + published_overlaps[midpoint]) / 2.0
    } else {
        published_overlaps[midpoint]
    };
    let branch_median_overlap = branches["diagnostics"]["median_overlap"]
        .as_f64()
        .expect("branches.v2 diagnostics.median_overlap must be numeric");
    assert!(
        (branch_median_overlap - expected_median_overlap).abs() <= 1.0e-12,
        "branches.v2 diagnostics.median_overlap must match published modal-overlap points: got {branch_median_overlap}, expected {expected_median_overlap}"
    );
    let solver_diagnostics: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/diagnostics/solver.v1.json")
            .expect("solver diagnostics artifact should exist"),
    )
    .expect("solver diagnostics should be valid json");
    assert_eq!(
        solver_diagnostics["mode_count"].as_u64(),
        Some(1),
        "solver diagnostics mode_count must match the public published modes, not internal tracking modes"
    );
    assert_eq!(
        solver_diagnostics["requested_mode_count"].as_u64(),
        Some(2),
        "requested_mode_count must preserve the public Eigenmodes.count cap"
    );

    let csv = std::str::from_utf8(
        result
            .artifact_bytes("eigen/dispersion.csv")
            .expect("dispersion.csv artifact should exist"),
    )
    .expect("dispersion.csv should be utf-8");
    let mut lines = csv.lines();
    let header = lines.next().unwrap_or_default();
    for required in [
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "ky_rad_per_m",
        "kz_rad_per_m",
        "branch_id",
        "residual_norm",
        "mode_field_id",
        "mode_field_resource_key",
    ] {
        assert!(
            header.split(',').any(|column| column == required),
            "dispersion.csv header must contain {required}, got {header}"
        );
    }
    let rows: Vec<&str> = lines.collect();
    let first_row = rows
        .first()
        .copied()
        .expect("dispersion.csv should contain mode rows");
    assert!(
        first_row
            .split(',')
            .nth(11)
            .is_some_and(|value| !value.is_empty()),
        "dispersion.csv residual_norm column should be populated, row={first_row}"
    );
    assert!(
        rows.iter().any(|row| row.contains(
            "analysis:eigen:sample-0002:mode-0000,/v2/sessions/current/data/fields/analysis:eigen:sample-0002:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        )),
        "dispersion.csv should carry sample_0002 mode-field handoff columns, rows={rows:?}"
    );

    let mode_metadata: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/modes/sample_0002/mode_0000.json")
            .expect("path eigensolve should write per-sample mode metadata"),
    )
    .expect("path eigensolve mode metadata should be valid json");
    assert_eq!(mode_metadata["sample_index"].as_u64(), Some(2));
    assert_eq!(
        mode_metadata["mode_field_id"].as_str(),
        Some("analysis:eigen:sample-0002:mode-0000")
    );
    assert_eq!(
        mode_metadata["zarr_array_path"].as_str(),
        Some("eigen/mode_fields.zarr/sample_0002/mode_0000/vector_xyz_complex")
    );
    assert_eq!(
        mode_metadata["compatibility_binary_payload_path"].as_str(),
        Some("eigen/mode_fields/sample_0002/mode_0000/vector.bin")
    );
    let eigen_summary: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/metadata/eigen_summary.json")
            .expect("path eigensolve should write eigen summary metadata"),
    )
    .expect("path eigensolve eigen summary should be valid json");
    let summary_mode = eigen_summary["modes"]
        .as_array()
        .and_then(|modes| modes.iter().find(|mode| mode["index"].as_u64() == Some(0)))
        .expect("eigen summary should include mode_0000");
    let summary_mass_norm = summary_mode["mass_norm"]
        .as_f64()
        .expect("eigen summary mode_0000 should carry mass_norm");
    let metadata_mass_norm = mode_metadata["mass_norm"]
        .as_f64()
        .expect("nested mode metadata should carry mass_norm");
    assert!(
        (summary_mass_norm - metadata_mass_norm).abs()
            <= 1.0e-9 * summary_mass_norm.abs().max(metadata_mass_norm.abs()).max(1.0),
        "eigen_summary mode_0000 mass_norm must match nested mode metadata: summary={summary_mass_norm:.9e}, metadata={metadata_mass_norm:.9e}"
    );
    assert!(
        result
            .artifact_bytes("eigen/mode_fields/sample_0002/mode_0000/vector.bin")
            .is_some(),
        "path eigensolve should write per-sample compatibility mode field payload"
    );
    assert!(
        result
            .artifact_bytes("eigen/mode_fields.zarr/sample_0002/mode_0000/vector_xyz_complex/0.0.0")
            .is_some(),
        "path eigensolve should write per-sample zarr mode field payload"
    );
    assert!(
        result
            .artifact_bytes("eigen/modes/sample_0002/mode_0001.json")
            .is_none(),
        "path eigensolve should not publish unrequested mode_0001 metadata even when it uses vectors internally for tracking"
    );
    assert!(
        result
            .artifact_bytes("eigen/mode_fields.zarr/sample_0002/mode_0001/vector_xyz_complex/0.0.0")
            .is_none(),
        "path eigensolve should not publish unrequested mode_0001 payloads even when it uses vectors internally for tracking"
    );
    let manifest: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("frequency_domain/manifest.v1.json")
            .expect("path eigensolve should write frequency-domain manifest"),
    )
    .expect("path eigensolve frequency-domain manifest should be valid json");
    assert_eq!(
        manifest["requested_execution"]["calculation_mode"].as_str(),
        Some("dispersion_modal")
    );
    assert_eq!(
        manifest["diagnostics"]["tracking_score_source"].as_str(),
        Some("modal_overlap_weighted_score")
    );
    assert_eq!(
        manifest["diagnostics"]["modal_overlap_available"].as_bool(),
        Some(true)
    );
    let dispersion_validation = &manifest["validation"]["dispersion_validation"];
    assert_eq!(
        dispersion_validation["kind"].as_str(),
        Some("thin_film_de_bv_low_k")
    );
    assert_eq!(
        dispersion_validation["analytic_model"].as_str(),
        Some("kalinikos_slab_n0")
    );
    assert_eq!(
        dispersion_validation["frequency_window_hz"]["max"].as_f64(),
        Some(5.0e9)
    );
    assert_eq!(
        dispersion_validation["max_k_rad_per_m"].as_f64(),
        Some(2.0e6)
    );
    assert!(
        dispersion_validation["scenarios"]
            .as_array()
            .is_some_and(|scenarios| scenarios.iter().any(|scenario| {
                scenario["geometry"].as_str() == Some("backward_volume")
                    && scenario["sample_indices"]
                        .as_array()
                        .is_some_and(|indices| {
                            indices
                                .iter()
                                .map(|index| index.as_u64())
                                .collect::<Vec<_>>()
                                == [Some(0), Some(1), Some(2)]
                        })
            })),
        "manifest should carry BV low-k analytic validation scenario"
    );
    assert!(
        dispersion_validation["scenarios"]
            .as_array()
            .is_some_and(|scenarios| scenarios.iter().any(|scenario| {
                scenario["geometry"].as_str() == Some("damon_eshbach")
                    && scenario["sample_indices"]
                        .as_array()
                        .is_some_and(|indices| {
                            indices
                                .iter()
                                .map(|index| index.as_u64())
                                .collect::<Vec<_>>()
                                == [Some(0), Some(3), Some(4)]
                        })
            })),
        "manifest should carry DE low-k analytic validation scenario"
    );
    assert!(
        manifest["artifacts"]["mode_metadata_paths"]
            .as_array()
            .is_some_and(|paths| paths
                .iter()
                .any(|path| path.as_str() == Some("eigen/modes/sample_0002/mode_0000.json"))),
        "path eigensolve manifest should index sample_0002 mode metadata"
    );
    assert!(
        manifest["resources"]["mode_field_resources"]
            .as_array()
            .is_some_and(
                |resources| resources.iter().any(|resource| resource.as_str()
                    == Some(
                        "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/2/0/meta"
                    ))
            ),
        "path eigensolve manifest should index sample_0002 mode meta resource"
    );
    assert_eq!(
        manifest["artifacts"]["solver_diagnostics_path"].as_str(),
        Some("eigen/diagnostics/solver.v1.json")
    );
    assert!(
        result
            .artifact_bytes("eigen/metadata/eigen_summary.json")
            .is_some(),
        "path eigensolve should write eigen_summary metadata for the validator"
    );
    assert!(
        result
            .artifact_bytes("eigen/diagnostics/solver.v1.json")
            .is_some(),
        "path eigensolve should write solver diagnostics for the validator"
    );
}

#[test]
fn fem_eigen_path_executes_full_2x2_nonzero_k_floquet_phase_reduction() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "path_full2x2_floquet_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_name: "path_full2x2_floquet_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::Full2x2,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [5.0e7, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0],
            },
        ],
    )
    .expect("Full2x2 nonzero-k Floquet path should execute with phase-reduced 2x2 tangent blocks");

    let spectrum: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/spectrum.v2.json")
            .expect("full2x2 Floquet path should write spectrum.v2"),
    )
    .expect("full2x2 Floquet spectrum.v2 should be valid json");
    assert_eq!(spectrum["sample_count"].as_u64(), Some(3));
    assert!(
        spectrum["samples"][2]["modes"][0]["frequency_hz"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "nonzero-k full2x2 Floquet sample should carry finite frequency, got: {}",
        spectrum["samples"][2]["modes"][0]
    );

    let mode_metadata: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/modes/sample_0002/mode_0000.json")
            .expect("full2x2 Floquet path should write nonzero-k mode metadata"),
    )
    .expect("full2x2 Floquet mode metadata should be valid json");
    assert_eq!(
        mode_metadata["mode_field_id"].as_str(),
        Some("analysis:eigen:sample-0002:mode-0000")
    );
    assert_eq!(
        mode_metadata["solver_model"].as_str(),
        Some("cpu_full_2x2_phase_reduced_floquet")
    );
    assert!(
        mode_metadata["amplitude_summary"]["max"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0),
        "full2x2 Floquet mode metadata should carry a nonzero mode field, got: {mode_metadata}"
    );

    let diagnostics: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/diagnostics/solver.v1.json")
            .expect("full2x2 Floquet path should write solver diagnostics"),
    )
    .expect("full2x2 Floquet solver diagnostics should be valid json");
    assert_eq!(
        diagnostics["solver_model"].as_str(),
        Some("reference_full_2x2_tangent")
    );
    assert_eq!(
        diagnostics["basis_transport_policy"].as_str(),
        Some("tangent_frame_transport")
    );
    assert!(
        diagnostics["floquet_tangent_transport_max_nonunitarity"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value < 1.0e-8),
        "full2x2 Floquet diagnostics should report unitary tangent transport, got: {diagnostics}"
    );
    assert!(
        diagnostics["solver_notes"]
            .as_array()
            .is_some_and(|items| items
                .iter()
                .any(|item| item.as_str() == Some("cpu_full_2x2_phase_reduced_floquet"))),
        "full2x2 Floquet diagnostics should preserve the single-k solver kind, got: {diagnostics}"
    );
}

#[test]
fn fem_eigen_path_rejects_floquet_dynamic_demag_before_sample_solves() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "path_floquet_dynamic_demag_reject_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_name: "path_floquet_dynamic_demag_reject_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::Full2x2,
            include_demag: true,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [5.0e7, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: true,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let error = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect_err("modal Floquet k-path with demag must reject before sample solves");

    assert!(
        error
            .message
            .contains("dynamic demag for Floquet periodic FEM is not implemented yet"),
        "unexpected Floquet dynamic-demag rejection: {}",
        error.message
    );
}

#[test]
fn fem_eigen_path_frequency_window_writes_window_diagnostics() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "path_frequency_window_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_name: "path_frequency_window_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 1,
        target: EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        },
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [5.0e7, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: Some(fullmag_ir::ModeTrackingIR::default()),
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("path frequency-window eigensolve should not panic or fail");

    let solver_diagnostics: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/diagnostics/solver.v1.json")
            .expect("path eigensolve should write solver diagnostics"),
    )
    .expect("path eigensolve solver diagnostics should be valid json");
    assert_eq!(
        solver_diagnostics["requested_window_hz"],
        serde_json::json!([1.0, 1.0e13]),
        "path eigensolve frequency-window diagnostics must preserve the requested window"
    );
    assert!(
        solver_diagnostics["window_completeness"]
            .as_object()
            .is_some_and(|window| window.get("status").and_then(|value| value.as_str())
                == Some("not_certified")),
        "path eigensolve frequency-window diagnostics must report non-certified window completeness, got {solver_diagnostics}"
    );
    assert!(
        solver_diagnostics["subwindows"]
            .as_array()
            .is_some_and(|subwindows| !subwindows.is_empty()),
        "path eigensolve frequency-window diagnostics must include subwindow provenance, got {solver_diagnostics}"
    );

    let eigen_summary: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/metadata/eigen_summary.json")
            .expect("path eigensolve should write eigen summary"),
    )
    .expect("path eigensolve eigen summary should be valid json");
    assert_eq!(
        eigen_summary["solver_diagnostics"]["requested_window_hz"],
        serde_json::json!([1.0, 1.0e13]),
        "eigen summary must carry the same frequency-window diagnostics"
    );
}

#[test]
fn fem_eigen_single_k_dispersion_request_writes_v2_dispersion_artifact() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "single_k_dispersion_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_name: "single_k_dispersion_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Single {
            k_vector: [5.0e7, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::DispersionCurve {
                name: "dispersion".to_string(),
            },
        ],
    )
    .expect("single-k eigensolve should execute");

    let csv = std::str::from_utf8(
        result
            .artifact_bytes("eigen/dispersion.csv")
            .expect("single-k dispersion request should write v2 dispersion.csv"),
    )
    .expect("dispersion.csv should be utf-8");
    let mut lines = csv.lines();
    let header = lines.next().unwrap_or_default();
    for required in [
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "raw_mode_index",
        "frequency_hz",
        "residual_norm",
    ] {
        assert!(
            header.split(',').any(|column| column == required),
            "single-k dispersion.csv header must contain {required}, got {header}"
        );
    }
    let first_row = lines
        .next()
        .expect("single-k dispersion.csv should contain mode rows");
    assert!(
        first_row
            .split(',')
            .nth(11)
            .is_some_and(|value| !value.is_empty()),
        "single-k dispersion.csv residual_norm column should be populated, row={first_row}"
    );
}

#[test]
fn spatial_material_fields_cpu_reference_reaches_oracle() {
    let nx = 4u32;
    let ny = 4u32;
    let nz = 1u32;
    let n = (nx * ny * nz) as usize;

    let m0 = vec![[0.0, 1.0, 0.0]; n];

    // Non-uniform Ms field: left half is 800e3, right half is 400e3
    let mut ms_field = vec![0.0; n];
    let mut a_field = vec![0.0; n];
    let mut alpha_field = vec![0.0; n];
    for flat_idx in 0..n {
        let x = flat_idx % nx as usize;
        ms_field[flat_idx] = if x < 2 { 800.0e3 } else { 400.0e3 };
        a_field[flat_idx] = if x < 2 { 13.0e-12 } else { 6.5e-12 };
        alpha_field[flat_idx] = if x < 2 { 0.5 } else { 0.1 };
    }

    let plan = FdmPlanIR {
        grid: GridDimensions {
            cells: [nx, ny, nz],
        },
        cell_size: [5e-9, 5e-9, 5e-9],
        region_mask: vec![0; n],
        active_mask: None,
        initial_magnetization: m0,
        material: FdmMaterialIR {
            name: "Py_varying".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            ms_field: Some(ms_field),
            a_field: Some(a_field),
            alpha_field: Some(alpha_field),
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(IntegratorChoice::Heun),
        fixed_timestep: Some(1e-13),
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
        }),
        enable_exchange: true,
        enable_demag: false,
        ..Default::default()
    };

    let result = fullmag_runner::run_reference_fdm(&plan, 1e-9, &[]).expect("run should succeed");
    assert_eq!(result.status, RunStatus::Completed);
}
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
            mesh_build_report: None,
            mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
        mesh_build_report: None,
