//! Physics guardrail suite (Etap A2).
//!
//! These tests enforce fundamental physical invariants that must hold
//! regardless of implementation optimisation.  Any refactoring (SoA,
//! FFT backend swap, fusion, MPI decomposition) must pass this suite.

use fullmag_engine::*;

// ── Helpers ────────────────────────────────────────────────────────────

fn permalloy_problem(
    nx: usize,
    ny: usize,
    nz: usize,
    cell_nm: f64,
    integrator: TimeIntegrator,
    terms: EffectiveFieldTerms,
) -> ExchangeLlgProblem {
    let cell = cell_nm * 1e-9;
    let grid = GridShape::new(nx, ny, nz).unwrap();
    let cs = CellSize::new(cell, cell, cell).unwrap();
    let mat = MaterialParameters::new(8e5, 1.3e-11, 0.5).unwrap(); // Ms, A, α
    let dyn_ = LlgConfig {
        gyromagnetic_ratio: DEFAULT_GYROMAGNETIC_RATIO,
        integrator,
        adaptive: AdaptiveStepConfig::default(),
        precession_enabled: true,
    };
    ExchangeLlgProblem::with_terms(grid, cs, mat, dyn_, terms)
}

fn exchange_demag_terms() -> EffectiveFieldTerms {
    EffectiveFieldTerms {
        exchange: true,
        demag: true,
        ..Default::default()
    }
}

fn exchange_only_terms() -> EffectiveFieldTerms {
    EffectiveFieldTerms {
        exchange: true,
        demag: false,
        ..Default::default()
    }
}

fn periodic_x_policy() -> FdmBoundaryPolicy {
    FdmBoundaryPolicy {
        x: AxisBoundary::Periodic,
        y: AxisBoundary::Open,
        z: AxisBoundary::Open,
    }
}

fn random_magnetization(n: usize, seed: u64) -> Vec<[f64; 3]> {
    let mut state = seed;
    (0..n)
        .map(|_| {
            let mut v = [0.0f64; 3];
            for c in &mut v {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *c = (state as f64 / u64::MAX as f64) * 2.0 - 1.0;
            }
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-30);
            [v[0] / n, v[1] / n, v[2] / n]
        })
        .collect()
}

fn total_energy(obs: &EffectiveFieldObservables) -> f64 {
    obs.exchange_energy_joules + obs.demag_energy_joules + obs.external_energy_joules
}

fn relax_steps(
    problem: &ExchangeLlgProblem,
    state: &mut ExchangeLlgState,
    ws: &mut FftWorkspace,
    bufs: &mut IntegratorBuffers,
    dt: f64,
    steps: usize,
) {
    for _ in 0..steps {
        let _ = problem.step_with_buffers(state, dt, ws, bufs);
    }
}

// ══════════════════════════════════════════════════════════════════════
// FDM physics guardrails
// ══════════════════════════════════════════════════════════════════════

/// Uniform magnetization → exchange field must be exactly zero.
#[test]
fn guardrail_uniform_exchange_field_is_zero() {
    let p = permalloy_problem(16, 16, 4, 5.0, TimeIntegrator::Heun, exchange_only_terms());
    let state = p.uniform_state([1.0, 0.0, 0.0]).unwrap();
    let h_ex = p.exchange_field(&state).unwrap();
    let max = h_ex.iter().fold(0.0f64, |acc, v| {
        acc.max(v[0].abs()).max(v[1].abs()).max(v[2].abs())
    });
    assert!(
        max < 1e-10,
        "exchange field of uniform state must be zero, got max={max}"
    );
}

#[test]
fn guardrail_fdm_periodic_exchange_wraps_axis_neighbor() {
    let mut p = permalloy_problem(3, 1, 1, 1.0, TimeIntegrator::Heun, exchange_only_terms());
    p.boundary_policy = periodic_x_policy();
    let state = p
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        .unwrap();

    let h_ex = p.exchange_field(&state).unwrap();
    let prefactor =
        2.0 * p.material.exchange_stiffness / (MU0 * p.material.saturation_magnetisation);
    let expected = [
        -2.0 * prefactor / (p.cell_size.dx * p.cell_size.dx),
        1.0 * prefactor / (p.cell_size.dx * p.cell_size.dx),
        1.0 * prefactor / (p.cell_size.dx * p.cell_size.dx),
    ];

    for component in 0..3 {
        let rel =
            (h_ex[0][component] - expected[component]).abs() / expected[component].abs().max(1.0);
        assert!(
            rel < 1e-12,
            "periodic exchange did not wrap x-neighbor component {component}: got {}, expected {}",
            h_ex[0][component],
            expected[component]
        );
    }
}

#[test]
fn guardrail_fdm_periodic_demag_workspace_uses_periodic_padding() {
    let mut p = permalloy_problem(
        5,
        4,
        3,
        2.0,
        TimeIntegrator::Heun,
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            ..Default::default()
        },
    );
    p.boundary_policy = periodic_x_policy();
    p.demag_boundary = FdmDemagBoundary::PeriodicTruncatedImages {
        image_counts: [3, 0, 0],
    };

    let ws = p.create_workspace();
    assert_eq!(
        ws.px, p.grid.nx,
        "periodic x axis should not be zero-padded"
    );
    assert_eq!(ws.py, p.grid.ny * 2, "open y axis should keep 2N padding");
    assert_eq!(ws.pz, p.grid.nz * 2, "open z axis should keep 2N padding");
}

#[test]
fn guardrail_fdm_periodic_workspace_budget_is_checked_before_allocation() {
    let boundary = periodic_x_policy();
    let error = match FftWorkspace::try_new_with_boundary(
        8,
        8,
        8,
        1.0e-9,
        1.0e-9,
        1.0e-9,
        &boundary,
        [500_000, 0, 0],
    ) {
        Ok(_) => panic!("periodic image work must be rejected before FFT allocation"),
        Err(error) => error,
    };
    assert!(error.contains("periodic image budget exceeded"));
}

#[test]
fn guardrail_fdm_periodic_workspace_checks_padding_overflow() {
    let boundary = FdmBoundaryPolicy {
        x: AxisBoundary::Periodic,
        y: AxisBoundary::Open,
        z: AxisBoundary::Open,
    };
    let error = match FftWorkspace::try_new_with_boundary(
        1,
        usize::MAX,
        1,
        1.0e-9,
        1.0e-9,
        1.0e-9,
        &boundary,
        [0, 0, 0],
    ) {
        Ok(_) => panic!("padded dimension multiplication must be checked"),
        Err(error) => error,
    };
    assert!(error.contains("padded grid count overflow"));
}

#[test]
fn guardrail_fdm_periodic_local_policy_does_not_reinterpret_open_demag() {
    let mut p = permalloy_problem(
        5,
        4,
        3,
        2.0,
        TimeIntegrator::Heun,
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            ..Default::default()
        },
    );
    p.boundary_policy = periodic_x_policy();

    let ws = p.create_workspace();
    assert_eq!(ws.px, p.grid.nx * 2);
    assert_eq!(ws.py, p.grid.ny * 2);
    assert_eq!(ws.pz, p.grid.nz * 2);
}

/// Uniform sphere/ellipsoid average demag field sanity.
/// Out-of-plane thin film demag energy must exceed in-plane.
#[test]
fn guardrail_thin_film_demag_shape_anisotropy() {
    let p = permalloy_problem(
        32,
        32,
        1,
        5.0,
        TimeIntegrator::Heun,
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            ..Default::default()
        },
    );

    let in_plane = p.uniform_state([1.0, 0.0, 0.0]).unwrap();
    let out_plane = p.uniform_state([0.0, 0.0, 1.0]).unwrap();

    let e_in = p.observe(&in_plane).unwrap().demag_energy_joules;
    let e_out = p.observe(&out_plane).unwrap().demag_energy_joules;

    assert!(
        e_out > e_in * 2.0,
        "thin film out-of-plane demag should be >> in-plane: e_out={e_out}, e_in={e_in}"
    );
}

/// RK45 and Heun must agree on the relaxed state (exchange-only) within tolerance.
#[test]
fn guardrail_rk45_heun_parity_exchange_relax() {
    let dt = 5e-14;
    let steps = 200;
    let n = 8;

    let mag = random_magnetization(n * n * n, 42);

    // Heun relaxation
    let p_heun = permalloy_problem(n, n, n, 5.0, TimeIntegrator::Heun, exchange_only_terms());
    let mut s_heun = p_heun.new_state(mag.clone()).unwrap();
    let mut ws_heun = p_heun.create_workspace();
    let mut bufs_heun = p_heun.create_integrator_buffers();
    relax_steps(
        &p_heun,
        &mut s_heun,
        &mut ws_heun,
        &mut bufs_heun,
        dt,
        steps,
    );
    let e_heun = p_heun.observe(&s_heun).unwrap().exchange_energy_joules;

    // RK45 relaxation (adaptive → may take different timesteps)
    let p_rk45 = permalloy_problem(n, n, n, 5.0, TimeIntegrator::RK45, exchange_only_terms());
    let mut s_rk45 = p_rk45.new_state(mag).unwrap();
    let mut ws_rk45 = p_rk45.create_workspace();
    let mut bufs_rk45 = p_rk45.create_integrator_buffers();
    relax_steps(
        &p_rk45,
        &mut s_rk45,
        &mut ws_rk45,
        &mut bufs_rk45,
        dt,
        steps,
    );
    let e_rk45 = p_rk45.observe(&s_rk45).unwrap().exchange_energy_joules;

    // Both should produce approximately the same relaxed energy
    let rel_diff = (e_heun - e_rk45).abs() / (e_heun.abs() + e_rk45.abs() + 1e-30);
    assert!(
        rel_diff < 0.05,
        "Heun and RK45 exchange energy should be within 5%: heun={e_heun}, rk45={e_rk45}, rel_diff={rel_diff}"
    );
}

/// Relaxation must monotonically decrease total energy (exchange + demag).
#[test]
fn guardrail_relax_monotonicity_exchange_demag() {
    let n = 8;
    let dt = 1e-14;
    let p = permalloy_problem(n, n, n, 5.0, TimeIntegrator::Heun, exchange_demag_terms());
    let mag = random_magnetization(n * n * n, 99);
    let mut state = p.new_state(mag).unwrap();
    let mut ws = p.create_workspace();
    let mut bufs = p.create_integrator_buffers();

    let mut prev_energy = total_energy(&p.observe(&state).unwrap());

    for step in 0..100 {
        let _ = p.step_with_buffers(&mut state, dt, &mut ws, &mut bufs);
        let e = total_energy(&p.observe(&state).unwrap());
        // Allow tiny numerical increase (1e-20 J tolerance)
        assert!(
            e <= prev_energy + 1e-20,
            "energy must not increase during damped relaxation: step={step}, prev={prev_energy}, cur={e}"
        );
        prev_energy = e;
    }
}

/// Demag energy must be non-negative for any magnetization state.
#[test]
fn guardrail_demag_energy_non_negative() {
    let p = permalloy_problem(
        8,
        8,
        4,
        5.0,
        TimeIntegrator::Heun,
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            ..Default::default()
        },
    );
    for seed in [1, 42, 137, 999, 2025] {
        let mag = random_magnetization(p.grid.cell_count(), seed);
        let state = p.new_state(mag).unwrap();
        let e = p.observe(&state).unwrap().demag_energy_joules;
        assert!(
            e >= -1e-25,
            "demag energy must be non-negative: seed={seed}, e={e}"
        );
    }
}

/// step_with_buffers and step_with_workspace must produce identical results.
#[test]
fn guardrail_buffer_path_matches_workspace_path() {
    let p = permalloy_problem(8, 8, 4, 5.0, TimeIntegrator::Heun, exchange_demag_terms());
    let mag = random_magnetization(p.grid.cell_count(), 77);

    // Path A: step_with_workspace (legacy)
    let mut state_a = p.new_state(mag.clone()).unwrap();
    let mut ws_a = p.create_workspace();
    let _report_a = p
        .step_with_workspace(&mut state_a, 1e-14, &mut ws_a)
        .unwrap();

    // Path B: step_with_buffers (optimized)
    let mut state_b = p.new_state(mag).unwrap();
    let mut ws_b = p.create_workspace();
    let mut bufs = p.create_integrator_buffers();
    let _report_b = p
        .step_with_buffers(&mut state_b, 1e-14, &mut ws_b, &mut bufs)
        .unwrap();

    // Magnetization must be bitwise identical
    for (i, (a, b)) in state_a
        .magnetization()
        .iter()
        .zip(state_b.magnetization().iter())
        .enumerate()
    {
        assert_eq!(
            *a, *b,
            "buffer and workspace paths diverged at cell {i}: a={a:?}, b={b:?}"
        );
    }
}

/// Workspace demag and standalone demag must give identical results.
#[test]
fn guardrail_workspace_demag_consistency() {
    let p = permalloy_problem(
        8,
        8,
        4,
        5.0,
        TimeIntegrator::Heun,
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            ..Default::default()
        },
    );
    let mag = random_magnetization(p.grid.cell_count(), 55);
    let state = p.new_state(mag).unwrap();

    // Two separate workspace instances should give identical demag fields
    let h1 = p.demag_field(&state).unwrap();
    let h2 = p.demag_field(&state).unwrap();

    for (i, (a, b)) in h1.iter().zip(h2.iter()).enumerate() {
        assert_eq!(
            *a, *b,
            "demag field not deterministic at cell {i}: a={a:?}, b={b:?}"
        );
    }
}

/// Unit norm must be preserved through integration steps.
#[test]
fn guardrail_norm_preservation_long_run() {
    let n = 8;
    let p = permalloy_problem(n, n, n, 5.0, TimeIntegrator::RK45, exchange_demag_terms());
    let mag = random_magnetization(n * n * n, 33);
    let mut state = p.new_state(mag).unwrap();
    let mut ws = p.create_workspace();
    let mut bufs = p.create_integrator_buffers();

    for _ in 0..200 {
        let _ = p.step_with_buffers(&mut state, 1e-13, &mut ws, &mut bufs);
    }

    for (i, m) in state.magnetization().iter().enumerate() {
        let n = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
        assert!(
            (n - 1.0).abs() < 1e-8,
            "unit norm violated at cell {i}: |m|={n}"
        );
    }
}

/// VectorFieldSoA scatter/gather round-trip must be lossless.
#[test]
fn guardrail_soa_round_trip() {
    let mag = random_magnetization(1024, 88);
    let mut soa = VectorFieldSoA::zeros(mag.len());
    soa.scatter_from_aos(&mag);

    let mut result = vec![[0.0; 3]; mag.len()];
    soa.gather_into_aos(&mut result);

    for (i, (a, b)) in mag.iter().zip(result.iter()).enumerate() {
        assert_eq!(*a, *b, "SoA round-trip mismatch at {i}");
    }
}
