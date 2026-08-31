use super::*;
use sha2::{Digest, Sha256};

fn resolved_frozen_spins(mask: Vec<bool>) -> fullmag_ir::ResolvedFrozenSpinsPlanIR {
    let frozen_dof_count = mask.iter().filter(|frozen| **frozen).count() as u64;
    let active_dof_count = mask.len() as u64;
    let free_dof_count = active_dof_count - frozen_dof_count;
    let mut hash = Sha256::new();
    hash.update(active_dof_count.to_le_bytes());
    hash.update(
        mask.iter()
            .map(|frozen| u8::from(*frozen))
            .collect::<Vec<_>>(),
    );
    let mask_sha256 = format!("{:x}", hash.finalize());
    fullmag_ir::ResolvedFrozenSpinsPlanIR {
        schema_version: fullmag_ir::RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION.to_string(),
        constraint_ids: vec!["pinned".to_string()],
        frozen_mask: mask,
        active_dof_count,
        frozen_dof_count,
        free_dof_count,
        mask_sha256: mask_sha256.clone(),
        grid_or_mesh_fingerprint: "physics-validation-frozen-grid".to_string(),
        source_state_revision: Some(1),
        all_active_dofs_frozen: active_dof_count > 0 && free_dof_count == 0,
        certificate: fullmag_ir::SelectionCertificateIR {
            schema_version: fullmag_ir::SELECTION_CERTIFICATE_SCHEMA_VERSION.to_string(),
            evaluator_id: "selection.fdm_cell_center.v1".to_string(),
            constraint_ids: vec!["pinned".to_string()],
            authored_fingerprints: vec![fullmag_ir::SelectionAuthoredFingerprintIR {
                constraint_id: "pinned".to_string(),
                selector_sha256: "a".repeat(64),
            }],
            raw_candidate_dof_count: frozen_dof_count,
            inactive_candidate_dof_count: 0,
            active_dof_count,
            frozen_dof_count,
            free_dof_count,
            bounds_m: None,
            grid_or_mesh_fingerprint: "physics-validation-frozen-grid".to_string(),
            source_state_revision: Some(1),
            mask_sha256,
            resolved_reference_sha256: "b".repeat(64),
            warnings: Vec::new(),
        },
    }
}

fn frozen_two_cell_plan() -> FdmPlanIR {
    certify_fdm_grid(FdmPlanIR {
        grid: GridDimensions { cells: [2, 1, 1] },
        cell_size: [2e-9, 2e-9, 2e-9],
        region_mask: vec![0; 2],
        initial_magnetization: vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        material: permalloy(),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(IntegratorChoice::Heun),
        fixed_timestep: Some(1e-14),
        enable_exchange: true,
        enable_demag: false,
        frozen_spins: Some(resolved_frozen_spins(vec![true, false])),
        ..Default::default()
    })
}

fn scientific_two_spin_problem(
    frozen_reference: [f64; 3],
) -> (
    fullmag_engine::ExchangeLlgProblem,
    fullmag_engine::ExchangeLlgState,
) {
    use fullmag_engine::{
        CellSize, EffectiveFieldTerms, ExchangeLlgProblem, GridShape, LlgConfig,
        MaterialParameters, TimeIntegrator, MU0,
    };

    // With dx=1, Ms=1 and A=mu0/2 the open-boundary two-cell exchange
    // coefficient 2A/(mu0*Ms*dx^2) is exactly one.  This keeps the oracle
    // independent of the production stencil implementation and makes every
    // expected field/RHS component analytically explicit.
    let mut problem = ExchangeLlgProblem::with_terms(
        GridShape::new(2, 1, 1).expect("valid two-spin grid"),
        CellSize::new(1.0, 1.0, 1.0).expect("valid unit cell"),
        MaterialParameters::new(1.0, 0.5 * MU0, 0.5).expect("valid oracle material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid oracle dynamics"),
        EffectiveFieldTerms {
            exchange: true,
            demag: false,
            external_field: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![frozen_reference, [0.0, 1.0, 0.0]])
        .expect("valid two-spin state");
    problem
        .capture_frozen_spins_at_activation(&resolved_frozen_spins(vec![true, false]), &mut state)
        .expect("two-spin Frozen Spins activation");
    (problem, state)
}

#[test]
fn frozen_spins_two_spin_exchange_matches_independent_oracle_and_reference_influence() {
    use fullmag_engine::MU0;

    let (positive_problem, positive_state) = scientific_two_spin_problem([1.0, 0.0, 0.0]);
    let positive_field = positive_problem
        .exchange_field(&positive_state)
        .expect("positive-reference exchange field");
    let positive_rhs = positive_problem
        .llg_rhs(&positive_state)
        .expect("positive-reference LLG RHS");

    // Analytic open-boundary two-spin oracle:
    // H_1 = m_0 - m_1 = (1,-1,0).  For m_1=(0,1,0), alpha=0.5,
    // gamma=1, LLG gives dm_1/dt=(0.4,0,0.8).  The frozen RHS is exactly zero.
    assert_eq!(positive_field[1], [1.0, -1.0, 0.0]);
    assert_eq!(
        positive_rhs[0].map(f64::to_bits),
        [0.0; 3].map(f64::to_bits)
    );
    assert_eq!(positive_rhs[1], [0.4, 0.0, 0.8]);

    // Both spins remain in the exchange energy.  For two unit-volume cells
    // with orthogonal spins the exact discrete energy is 2*A = mu0.
    let positive_energy = positive_problem
        .exchange_energy(&positive_state)
        .expect("positive-reference exchange energy");
    assert!(
        (positive_energy - MU0).abs() <= 8.0 * f64::EPSILON * MU0,
        "Frozen spin must remain in exchange energy: actual={positive_energy:e}, expected={MU0:e}"
    );

    let (negative_problem, negative_state) = scientific_two_spin_problem([-1.0, 0.0, 0.0]);
    let negative_field = negative_problem
        .exchange_field(&negative_state)
        .expect("negative-reference exchange field");
    let negative_rhs = negative_problem
        .llg_rhs(&negative_state)
        .expect("negative-reference LLG RHS");

    assert_eq!(negative_field[1], [-1.0, -1.0, 0.0]);
    assert_eq!(
        negative_rhs[0].map(f64::to_bits),
        [0.0; 3].map(f64::to_bits)
    );
    assert_eq!(negative_rhs[1], [-0.4, 0.0, -0.8]);
    assert_ne!(
        positive_rhs[1].map(f64::to_bits),
        negative_rhs[1].map(f64::to_bits),
        "Changing only the frozen reference must influence the free-spin dynamics"
    );
}

#[test]
fn frozen_spins_fdm_cpu_preserves_pinned_cell_and_evolves_free_exchange_neighbor() {
    let plan = frozen_two_cell_plan();
    let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
        .expect("two-cell frozen-spin reference run should succeed");

    assert_eq!(
        result.final_magnetization[0].map(f64::to_bits),
        plan.initial_magnetization[0].map(f64::to_bits),
        "the frozen cell must remain bitwise equal to its captured reference"
    );
    assert_ne!(
        result.final_magnetization[1].map(f64::to_bits),
        plan.initial_magnetization[1].map(f64::to_bits),
        "the free exchange neighbour must still evolve"
    );
}

#[test]
fn frozen_spins_fdm_cpu_keeps_pinned_source_in_exchange_and_demag() {
    let mut plan = frozen_two_cell_plan();
    plan.enable_demag = true;
    let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
        .expect("frozen exchange-demag reference run should succeed");

    assert_eq!(
        result.final_magnetization[0].map(f64::to_bits),
        plan.initial_magnetization[0].map(f64::to_bits),
        "a frozen source must stay fixed while remaining present in field assembly"
    );
    assert_ne!(
        result.final_magnetization[1].map(f64::to_bits),
        plan.initial_magnetization[1].map(f64::to_bits),
        "demag/exchange from the frozen neighbour must drive the free cell"
    );
}

#[test]
fn frozen_spins_fdm_cpu_masks_stt_sot_and_thermal_rhs() {
    let mut plan = frozen_two_cell_plan();
    plan.current_density = Some([1.0e12, 0.0, 0.0]);
    plan.stt_degree = Some(0.5);
    plan.stt_beta = Some(0.1);
    plan.sot_current_density = Some(1.0e11);
    plan.sot_xi_dl = Some(0.1);
    plan.sot_xi_fl = Some(0.05);
    plan.sot_sigma = Some([0.0, 1.0, 0.0]);
    plan.sot_thickness = Some(2.0e-9);
    plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
    plan.sot_target = Some(fullmag_ir::RegionRefIR {
        object_id: "magnet".to_string(),
        region_id: None,
    });
    plan.sot_active_mask = Some(vec![true, true]);
    plan.sot_envelope = Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 1.0 });
    plan.sot_drive = Some(fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
        current_density_apm2: 1.0e11,
        sigma_hat: [0.0, 1.0, 0.0],
        envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 1.0 }),
    });
    plan.temperature = Some(300.0);
    plan.thermal_seed_config = Some(fullmag_ir::ThermalSeedConfig {
        policy: fullmag_ir::SeedPolicy::Fixed,
        seed: Some(7),
    });

    let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
        .expect("frozen STT/SOT/thermal reference run should succeed");

    assert_eq!(
        result.final_magnetization[0].map(f64::to_bits),
        plan.initial_magnetization[0].map(f64::to_bits),
        "final RHS masking must suppress every torque source on a frozen cell"
    );
}

#[test]
fn frozen_spins_thermal_fixed_seed_is_bitwise_reproducible() {
    let mut plan = frozen_two_cell_plan();
    plan.enable_exchange = false;
    plan.temperature = Some(300.0);
    plan.thermal_seed_config = Some(fullmag_ir::ThermalSeedConfig {
        policy: fullmag_ir::SeedPolicy::Fixed,
        seed: Some(0x5eed),
    });

    let first = fullmag_runner::run_reference_fdm(&plan, 4e-14, &[])
        .expect("first fixed-seed Frozen Spins thermal run");
    let second = fullmag_runner::run_reference_fdm(&plan, 4e-14, &[])
        .expect("second fixed-seed Frozen Spins thermal run");

    assert_eq!(
        first
            .final_magnetization
            .iter()
            .map(|value| value.map(f64::to_bits))
            .collect::<Vec<_>>(),
        second
            .final_magnetization
            .iter()
            .map(|value| value.map(f64::to_bits))
            .collect::<Vec<_>>(),
        "fixed thermal seed must reproduce the full constrained trajectory bitwise"
    );
    assert_eq!(
        first.final_magnetization[0].map(f64::to_bits),
        plan.initial_magnetization[0].map(f64::to_bits),
        "thermal noise must not move the frozen reference"
    );
    assert_ne!(
        first.final_magnetization[1].map(f64::to_bits),
        plan.initial_magnetization[1].map(f64::to_bits),
        "the free spin must still sample the thermal trajectory"
    );
}

#[test]
fn frozen_spins_fdm_cpu_all_frozen_completes_without_integrator_steps() {
    let mut plan = frozen_two_cell_plan();
    plan.frozen_spins = Some(resolved_frozen_spins(vec![true, true]));
    plan.external_field = Some([0.0, 0.0, 8.0e5]);
    let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
        .expect("all-frozen reference run should succeed");

    assert!(
        result.steps.iter().all(|step| step.step == 0),
        "all-frozen execution must not enter an integrator step"
    );
    assert_eq!(
        result.final_magnetization, plan.initial_magnetization,
        "all-frozen execution must preserve the whole captured state"
    );
}

#[test]
fn frozen_spins_fdm_cpu_publishes_free_and_all_telemetry_without_hiding_pinned_torque() {
    let mut plan = frozen_two_cell_plan();
    plan.frozen_spins = Some(resolved_frozen_spins(vec![true, true]));
    plan.enable_exchange = false;
    plan.external_field = Some([0.0, 0.0, 8.0e5]);
    let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
        .expect("all-frozen telemetry run should succeed");
    let final_step = result.steps.last().expect("all-frozen scalar snapshot");
    let value = serde_json::to_value(final_step).expect("StepStats serializes");

    assert_eq!(value["max_rhs_norm_per_s"], 0.0);
    assert_eq!(value["max_torque_Apm"], 0.0);
    assert!(
        value["max_rhs_all_norm_per_s"].as_f64().unwrap_or_default() > 0.0,
        "all-domain RHS diagnostic must retain the pre-mask frozen contribution"
    );
    assert!(
        value["max_torque_all_Apm"].as_f64().unwrap_or_default() > 0.0,
        "all-domain torque diagnostic must retain the frozen contribution"
    );
    assert_eq!(value["frozen_reference_max_drift"], 0.0);
    assert_eq!(value["active_dof_count"], 2.0);
    assert_eq!(value["frozen_dof_count"], 2.0);
    assert_eq!(value["free_dof_count"], 0.0);
}

#[test]
fn frozen_spins_all_frozen_telemetry_retains_stt_sot_and_thermal_rhs() {
    let mut plan = frozen_two_cell_plan();
    plan.frozen_spins = Some(resolved_frozen_spins(vec![true, true]));
    plan.enable_exchange = false;
    plan.current_density = Some([1.0e12, 0.0, 0.0]);
    plan.stt_degree = Some(0.5);
    plan.stt_beta = Some(0.1);
    plan.sot_current_density = Some(1.0e11);
    plan.sot_xi_dl = Some(0.1);
    plan.sot_xi_fl = Some(0.05);
    plan.sot_sigma = Some([0.0, 1.0, 0.0]);
    plan.sot_thickness = Some(2.0e-9);
    plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
    plan.sot_target = Some(fullmag_ir::RegionRefIR {
        object_id: "magnet".to_string(),
        region_id: None,
    });
    plan.sot_active_mask = Some(vec![true, true]);
    plan.sot_envelope = Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 1.0 });
    plan.sot_drive = Some(fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
        current_density_apm2: 1.0e11,
        sigma_hat: [0.0, 1.0, 0.0],
        envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 1.0 }),
    });
    plan.temperature = Some(300.0);
    plan.thermal_seed_config = Some(fullmag_ir::ThermalSeedConfig {
        policy: fullmag_ir::SeedPolicy::Fixed,
        seed: Some(7),
    });

    let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
        .expect("all-frozen STT/SOT/thermal telemetry run should succeed");
    let final_step = result.steps.last().expect("all-frozen scalar snapshot");

    assert_eq!(final_step.max_rhs_norm_per_s, 0.0);
    assert_eq!(final_step.max_torque_Apm, 0.0);
    assert!(
        final_step.max_rhs_all_norm_per_s > 0.0,
        "all-DOF RHS must retain STT/SOT/thermal forcing"
    );
    assert!(
        final_step.max_torque_all_Apm > 0.0,
        "all-DOF torque must retain thermal effective-field forcing"
    );
}

#[test]
fn frozen_spins_fdm_cpu_preserves_candidate_references_for_every_public_integrator() {
    for integrator in [
        IntegratorChoice::Heun,
        IntegratorChoice::Rk4,
        IntegratorChoice::Rk23,
        IntegratorChoice::Rk45,
        IntegratorChoice::Abm3,
    ] {
        let mut plan = frozen_two_cell_plan();
        plan.integrator = Some(integrator);
        let result = fullmag_runner::run_reference_fdm(&plan, 4e-14, &[])
            .unwrap_or_else(|error| panic!("{integrator:?}: frozen-spin run failed: {error}"));
        assert_eq!(
            result.final_magnetization[0].map(f64::to_bits),
            plan.initial_magnetization[0].map(f64::to_bits),
            "{integrator:?}: every candidate and accepted state must restore the frozen reference"
        );
    }
}

#[test]
fn frozen_spins_fdm_cpu_false_mask_is_bitwise_legacy_parity() {
    for integrator in [
        IntegratorChoice::Heun,
        IntegratorChoice::Rk4,
        IntegratorChoice::Rk23,
        IntegratorChoice::Rk45,
        IntegratorChoice::Abm3,
    ] {
        let mut constrained = frozen_two_cell_plan();
        constrained.frozen_spins = Some(resolved_frozen_spins(vec![false, false]));
        constrained.integrator = Some(integrator);
        let mut legacy = constrained.clone();
        legacy.frozen_spins = None;

        let constrained_result = fullmag_runner::run_reference_fdm(&constrained, 4e-14, &[])
            .unwrap_or_else(|error| panic!("{integrator:?}: no-op mask run failed: {error}"));
        let legacy_result = fullmag_runner::run_reference_fdm(&legacy, 4e-14, &[])
            .unwrap_or_else(|error| panic!("{integrator:?}: legacy run failed: {error}"));

        assert_eq!(
            constrained_result
                .final_magnetization
                .iter()
                .map(|value| value.map(f64::to_bits))
                .collect::<Vec<_>>(),
            legacy_result
                .final_magnetization
                .iter()
                .map(|value| value.map(f64::to_bits))
                .collect::<Vec<_>>(),
            "{integrator:?}: a resolved mask with no frozen DOFs must retain the legacy numerical path"
        );
        let constrained_step = constrained_result
            .steps
            .last()
            .expect("constrained step stats");
        assert_eq!(
            constrained_step.max_rhs_norm_per_s, constrained_step.max_rhs_all_norm_per_s,
            "{integrator:?}: no-mask legacy RHS alias must equal all-DOF telemetry"
        );
        assert_eq!(
            constrained_step.max_torque_Apm, constrained_step.max_torque_all_Apm,
            "{integrator:?}: no-mask legacy torque alias must equal all-DOF telemetry"
        );
    }
}

fn frozen_direct_minimizer_plan(
    algorithm: RelaxationAlgorithmIR,
    frozen_mask: Vec<bool>,
) -> FdmPlanIR {
    let mut plan = frozen_two_cell_plan();
    plan.frozen_spins = Some(resolved_frozen_spins(frozen_mask));
    plan.external_field = Some([0.0, 0.0, 8.0e5]);
    plan.relaxation = Some(RelaxationControlIR {
        algorithm,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(4),
            max_relaxation_time_s: None,
        },
    });
    plan
}

#[test]
fn frozen_spins_direct_minimizer_preserves_reference_with_one_free_dof() {
    for algorithm in [
        RelaxationAlgorithmIR::ProjectedGradientBb,
        RelaxationAlgorithmIR::NonlinearCg,
    ] {
        let plan = frozen_direct_minimizer_plan(algorithm, vec![true, false]);
        let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
            .unwrap_or_else(|error| panic!("{algorithm:?}: constrained minimizer failed: {error}"));

        assert_eq!(
            result.final_magnetization[0].map(f64::to_bits),
            plan.initial_magnetization[0].map(f64::to_bits),
            "{algorithm:?}: every line-search trial and accepted state must restore the frozen reference"
        );
        assert_ne!(
            result.final_magnetization[1].map(f64::to_bits),
            plan.initial_magnetization[1].map(f64::to_bits),
            "{algorithm:?}: the single free DOF must remain eligible for minimization"
        );
        let final_step = result.steps.last().expect("direct minimizer stats");
        assert!(final_step.e_total.is_finite());
        assert!(final_step.max_torque_Apm.is_finite());
        assert_eq!(final_step.frozen_reference_max_drift, 0.0);
        assert_eq!(final_step.frozen_dof_count, 1);
        assert_eq!(final_step.free_dof_count, 1);
        for pair in result.steps.windows(2) {
            let tolerance = 64.0 * f64::EPSILON * pair[0].e_total.abs().max(1.0e-30);
            assert!(
                pair[1].e_total <= pair[0].e_total + tolerance,
                "{algorithm:?}: accepted minimizer energy must be monotonic: {} -> {}",
                pair[0].e_total,
                pair[1].e_total
            );
        }
    }
}

#[test]
fn frozen_spins_direct_minimizer_all_frozen_is_finite_zero_step_noop() {
    for algorithm in [
        RelaxationAlgorithmIR::ProjectedGradientBb,
        RelaxationAlgorithmIR::NonlinearCg,
    ] {
        let plan = frozen_direct_minimizer_plan(algorithm, vec![true, true]);
        let result = fullmag_runner::run_reference_fdm(&plan, 1e-14, &[])
            .unwrap_or_else(|error| panic!("{algorithm:?}: all-frozen minimizer failed: {error}"));

        assert_eq!(
            result
                .final_magnetization
                .iter()
                .map(|value| value.map(f64::to_bits))
                .collect::<Vec<_>>(),
            plan.initial_magnetization
                .iter()
                .map(|value| value.map(f64::to_bits))
                .collect::<Vec<_>>(),
            "{algorithm:?}: an empty free domain is an exact no-op"
        );
        assert!(result.steps.iter().all(|step| step.step == 0));
        let final_step = result.steps.last().expect("all-frozen minimizer stats");
        assert!(final_step.e_total.is_finite());
        assert_eq!(final_step.max_torque_Apm, 0.0);
        assert_eq!(final_step.frozen_reference_max_drift, 0.0);
        assert_eq!(final_step.frozen_dof_count, 2);
        assert_eq!(final_step.free_dof_count, 0);
    }
}

fn assert_authoritative_relaxation_completion(
    result: &fullmag_runner::RunResult,
    workload: &str,
    max_steps: u64,
) {
    assert_eq!(
        result.status,
        RunStatus::Completed,
        "{workload}: runner must finish with Completed"
    );
    let completion = result
        .completion
        .as_ref()
        .unwrap_or_else(|| panic!("{workload}: missing authoritative completion"));
    assert!(
        completion.converged,
        "{workload}: Completed without completion.converged=true: {completion:?}"
    );
    assert!(
        matches!(
            completion.reason,
            Some(fullmag_ir::StageStopReason::Torque | fullmag_ir::StageStopReason::Energy)
        ),
        "{workload}: completion reason is not a convergence reason: {completion:?}"
    );
    assert!(
        result.steps.len() < max_steps as usize,
        "{workload}: qualification must not terminate at max_steps"
    );
    let final_step = result
        .steps
        .last()
        .unwrap_or_else(|| panic!("{workload}: no accepted scalar step"));
    for (name, value) in [
        ("e_total", final_step.e_total),
        ("max_torque_Apm", final_step.max_torque_Apm),
        ("max_torque_T", final_step.max_torque_T),
        ("max_rhs_norm_per_s", final_step.max_rhs_norm_per_s),
    ] {
        assert!(
            value.is_finite(),
            "{workload}: {name} is not finite: {value}"
        );
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

    let plan = certify_fdm_grid(FdmPlanIR {
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
        static_external_field_xyz: None,
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
    });

    let result = fullmag_runner::run_reference_fdm(&plan, 1e-9, &[]).expect("run should succeed");
    assert_authoritative_relaxation_completion(
        &result,
        "fdm_cpu_fp64.llg_overdamped.macrospin",
        50_000,
    );

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

    let plan = certify_fdm_grid(FdmPlanIR {
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
        static_external_field_xyz: None,
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
    });

    let result = fullmag_runner::run_reference_fdm(&plan, 1e-9, &[]).expect("run should succeed");
    assert_authoritative_relaxation_completion(
        &result,
        "fdm_cpu_fp64.projected_gradient_bb.exchange_only",
        10_000,
    );

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

    let plan = certify_fdm_grid(FdmPlanIR {
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
        static_external_field_xyz: None,
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
    });

    let result = fullmag_runner::run_reference_fdm(&plan, 10e-9, &[]).expect("run should succeed");
    assert_authoritative_relaxation_completion(
        &result,
        "fdm_cpu_fp64.llg_overdamped.thin_film_demag",
        50_000,
    );

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
    assert_authoritative_relaxation_completion(&result, "fdm_cpu_fp64.llg_overdamped.sp4", 50_000);

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
        assert_authoritative_relaxation_completion(
            &result,
            &format!("fdm_cpu_fp64.{}.sp4", name.to_ascii_lowercase()),
            50_000,
        );
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
    assert_authoritative_relaxation_completion(
        &relax_result,
        "fdm_cpu_fp64.llg_overdamped.sp4.reversal_prestage",
        50_000,
    );

    let relaxed_m = relax_result.final_magnetization;

    // Phase 2: Apply reversal field and run dynamics with physical damping
    let n = relaxed_m.len();
    // B_ext = (-24.6, 4.3, 0) mT → H_ext = B / μ₀
    let mu0 = 4.0 * std::f64::consts::PI * 1e-7;
    let h_ext = [-24.6e-3 / mu0, 4.3e-3 / mu0, 0.0];

    let dyn_plan = certify_fdm_grid(FdmPlanIR {
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
        static_external_field_xyz: None,
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
    });

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
