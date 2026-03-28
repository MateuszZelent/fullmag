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
    ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FdmPlanIR, GridDimensions,
    IntegratorChoice, RelaxationAlgorithmIR, RelaxationControlIR,
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
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-13),
        adaptive_timestep: None,
        relaxation: Some(RelaxationControlIR {
            algorithm,
            torque_tolerance: 1e-4,
            energy_tolerance: None,
            max_steps: 50_000,
        }),
        enable_exchange: true,
        enable_demag,
        external_field: None,
        boundary_correction: None,
        inter_region_exchange: vec![],
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
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-14),
        adaptive_timestep: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            torque_tolerance: 1e-5,
            energy_tolerance: None,
            max_steps: 50_000,
        }),
        enable_exchange: false,
        enable_demag: false,
        // Strong field along +x: H = 1e6 A/m ≈ 1.26 T
        external_field: Some([1e6, 0.0, 0.0]),
        boundary_correction: None,
        inter_region_exchange: vec![],
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
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-14),
        adaptive_timestep: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            torque_tolerance: 1e-6,
            energy_tolerance: None,
            max_steps: 10_000,
        }),
        enable_exchange: true,
        enable_demag: false,
        external_field: None,
        boundary_correction: None,
        inter_region_exchange: vec![],
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
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-13),
        adaptive_timestep: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            torque_tolerance: 1e-3,
            energy_tolerance: None,
            max_steps: 50_000,
        }),
        enable_exchange: true,
        enable_demag: true,
        external_field: None,
        boundary_correction: None,
        inter_region_exchange: vec![],
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
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(5e-14), // needs small dt for dynamics with α=0.02
        adaptive_timestep: None,
        relaxation: None, // no relaxation — pure dynamics
        boundary_correction: None,
        inter_region_exchange: vec![],
        enable_exchange: true,
        enable_demag: true,
        external_field: Some(h_ext),
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
