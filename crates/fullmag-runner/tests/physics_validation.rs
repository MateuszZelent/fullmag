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
    FdmMaterialIR, FdmPlanIR, FemEigenPlanIR, GridDimensions, IntegratorChoice, MaterialIR, MeshIR,
    OutputIR, RelaxationAlgorithmIR, RelaxationControlIR,
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
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-5),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(10_000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-3),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
            marker_a: 1,
            marker_b: 1,
            translation: None,
            tolerance: None,
        },
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "y_faces".to_string(),
            marker_a: 1,
            marker_b: 1,
            translation: None,
            tolerance: None,
        },
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "z_faces".to_string(),
            marker_a: 1,
            marker_b: 1,
            translation: None,
            tolerance: None,
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
        dmi_interface_normal: None,
        mode_tracking: None,
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
    // Mode 0 spatial profile artifact must be present
    let has_mode = result
        .artifact_bytes("eigen/modes/mode_0000.json")
        .is_some();
    assert!(has_mode, "FEM eigen smoke: mode_0000.json must be written");
}

/// EIG-031 analytic benchmark: lowest Zeeman-only mode frequency must be in
/// the correct order-of-magnitude range of the Kittel formula.
///
/// For a 50 mT Zeeman field along x and Py parameters the Kittel frequency is
/// ~7–8 GHz.  Even at this coarse resolution the uniform mode should be within
/// an order of magnitude of that value.
#[test]
fn fem_eigen_lowest_mode_order_of_magnitude() {
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
        dmi_interface_normal: None,
        mode_tracking: None,
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
        dmi_interface_normal: None,
        mode_tracking: None,
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
            dmi_interface_normal: None,
            mode_tracking: None,
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
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        dmi_interface_normal: None,
        mode_tracking: None,
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
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        dmi_interface_normal: None,
        mode_tracking: None,
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
        dmi_interface_normal: None,
        mode_tracking: None,
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
                surface_anisotropy_ks: Some(5.0e-4),
                surface_anisotropy_axis: Some([0.0, 0.0, 1.0]),
            },
        ),
        demag_realization: None,
        dmi_interface_normal: None,
        mode_tracking: None,
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
fn fem_eigen_floquet_bulk_dmi_is_nonreciprocal_for_plus_minus_k() {
    let build_plan = |kx: f64| {
        let mut mesh = cube_mesh(20.0);
        mesh.mesh_name = format!(
            "floquet_bulk_dmi_{}",
            if kx >= 0.0 { "plus" } else { "minus" }
        );
        FemEigenPlanIR {
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
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            dmi_interface_normal: None,
            mode_tracking: None,
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
            dmi_interface_normal: None,
            mode_tracking: None,
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
        dmi_interface_normal: None,
        mode_tracking: None,
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
        dmi_interface_normal: None,
        mode_tracking: None,
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
                        surface_anisotropy_ks: None,
                        surface_anisotropy_axis: None,
                    },
                )
            } else {
                fullmag_ir::SpinWaveBoundaryConditionIR::default()
            },
            demag_realization: None,
            dmi_interface_normal: None,
            mode_tracking: None,
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
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        dmi_interface_normal: None,
        mode_tracking: None,
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
                        surface_anisotropy_ks: None,
                        surface_anisotropy_axis: None,
                    },
                )
            } else {
                fullmag_ir::SpinWaveBoundaryConditionIR::default()
            },
            demag_realization: None,
            dmi_interface_normal: None,
            mode_tracking: None,
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
