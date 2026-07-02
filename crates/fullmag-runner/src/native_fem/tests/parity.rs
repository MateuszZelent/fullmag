use super::*;

#[test]
fn native_fem_exchange_only_matches_cpu_reference_when_mfem_stack_is_available() {
    if !is_gpu_available() {
        eprintln!(
                "skipping native FEM parity test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
        return;
    }

    let plan = make_exchange_only_plan();
    let (expected_m, expected_h_ex, expected_h_eff, expected_report) =
        cpu_reference_single_step(&plan);

    let mut backend = NativeFemBackend::create(&plan).expect("native fem create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native exchange-only fem step");
    let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
    let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
    let actual_h_eff = backend
        .copy_h_eff(plan.mesh.nodes.len())
        .expect("copy H_eff");

    assert_vector_field_close("m", &actual_m, &expected_m, 5e-8, 1e-10);
    assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-8, 1e-6);
    assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);

    assert_scalar_close(
        "time_seconds",
        stats.time,
        expected_report.time_seconds,
        1e-12,
        1e-18,
    );
    assert_scalar_close(
        "exchange_energy_joules",
        stats.e_ex,
        expected_report.exchange_energy_joules,
        5e-8,
        1e-18,
    );
    assert_scalar_close(
        "external_energy_joules",
        stats.e_ext,
        expected_report.external_energy_joules,
        5e-8,
        1e-18,
    );
    assert_scalar_close(
        "total_energy_joules",
        stats.e_total,
        expected_report.total_energy_joules,
        5e-8,
        1e-18,
    );
    assert_scalar_close(
        "max_effective_field_amplitude",
        stats.max_h_eff,
        expected_report.max_effective_field_amplitude,
        5e-8,
        1e-9,
    );
    assert_scalar_close(
        "max_rhs_amplitude",
        stats.max_dm_dt,
        expected_report.max_rhs_amplitude,
        5e-8,
        1e-9,
    );
    assert_eq!(stats.rhs_evals, 3);
    assert_eq!(stats.demag_solves, 0);
    assert!(!stats.demag_refreshed);
}

#[test]
fn native_fem_cpu_gpu_exchange_h_eff_and_rhs_parity_when_available() {
    if !native_cpu_gpu_parity_available(false) {
        return;
    }

    for pure_damping in [false, true] {
        let mut plan = make_exchange_only_plan();
        if pure_damping {
            plan.relaxation = Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                stop: RelaxStopIR {
                    torque_tolerance_apm: None,
                    energy_tolerance_j: None,
                    max_steps: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            });
        }
        let cpu_plan = native_plan_for_device(&plan, "cpu");
        let gpu_plan = native_plan_for_device(&plan, "cuda");
        assert_same_parity_mesh(&cpu_plan, &gpu_plan);

        let cpu = run_native_parity_step(&cpu_plan);
        let gpu = run_native_parity_step(&gpu_plan);
        assert!(
            cpu.device_name.contains("cpu") || cpu.device_name.contains("mfem"),
            "CPU parity provenance device was {}",
            cpu.device_name
        );
        assert!(
            gpu.device_name.contains("cuda")
                || gpu.device_name.contains("NVIDIA")
                || gpu.device_name.contains("GeForce")
                || gpu.device_name.contains("RTX"),
            "GPU parity provenance device was {}",
            gpu.device_name
        );

        let mode = if pure_damping {
            "pure_damping"
        } else {
            "precessional"
        };
        assert_vector_field_parity(&format!("{mode}.H_ex"), &cpu.h_ex, &gpu.h_ex, 5e-8, 1e-6);
        assert_vector_field_parity(&format!("{mode}.H_eff"), &cpu.h_eff, &gpu.h_eff, 5e-8, 1e-6);
        assert_vector_field_parity(&format!("{mode}.m"), &cpu.m, &gpu.m, 5e-8, 1e-10);
        assert_scalar_close(
            &format!("{mode}.max_rhs_amplitude"),
            gpu.stats.max_dm_dt,
            cpu.stats.max_dm_dt,
            5e-8,
            1e-9,
        );
    }
}

#[test]
fn native_fem_cpu_gpu_demag_parity_when_full_gpu_demag_is_available() {
    if !native_cpu_gpu_parity_available(true) {
        return;
    }

    let plan = with_poisson_demag(make_exchange_only_plan());
    let cpu_plan = native_plan_for_device(&plan, "cpu");
    let gpu_plan = native_plan_for_device(&plan, "cuda");
    assert_same_parity_mesh(&cpu_plan, &gpu_plan);

    let cpu = run_native_parity_step(&cpu_plan);
    let gpu = run_native_parity_step(&gpu_plan);
    assert_vector_field_parity("demag.H_demag", &cpu.h_demag, &gpu.h_demag, 5e-8, 1e-6);
    assert_vector_field_parity("demag.H_eff", &cpu.h_eff, &gpu.h_eff, 5e-8, 1e-6);
    assert_scalar_close(
        "demag_energy_joules",
        gpu.stats.e_demag,
        cpu.stats.e_demag,
        5e-8,
        1e-18,
    );
    assert!(
        gpu.stats.demag_solves > 0,
        "GPU demag parity fixture must exercise the Poisson solve"
    );
}

#[test]
fn native_fem_cpu_gpu_integrator_parity_when_available() {
    if !native_cpu_gpu_parity_available(false) {
        return;
    }

    for integrator in [
        IntegratorChoice::Heun,
        IntegratorChoice::Rk4,
        IntegratorChoice::Rk23,
        IntegratorChoice::Rk45,
    ] {
        let mut plan = make_exchange_only_plan();
        plan.integrator = integrator;
        if matches!(integrator, IntegratorChoice::Rk23 | IntegratorChoice::Rk45) {
            plan = with_adaptive_dt(plan);
        }
        let cpu_plan = native_plan_for_device(&plan, "cpu");
        let gpu_plan = native_plan_for_device(&plan, "cuda");
        assert_same_parity_mesh(&cpu_plan, &gpu_plan);

        let cpu = run_native_parity_step(&cpu_plan);
        let gpu = run_native_parity_step(&gpu_plan);
        assert_vector_field_parity(&format!("{integrator:?}.m"), &cpu.m, &gpu.m, 5e-8, 1e-10);
        assert_vector_field_parity(
            &format!("{integrator:?}.H_eff"),
            &cpu.h_eff,
            &gpu.h_eff,
            5e-8,
            1e-6,
        );
        assert_eq!(
            gpu.stats.rhs_evals, cpu.stats.rhs_evals,
            "RHS evaluation count mismatch for {integrator:?}"
        );
    }
}

#[test]
fn native_fem_explicit_rk_reports_real_rhs_cost_when_mfem_stack_is_available() {
    if !is_gpu_available() {
        eprintln!(
                "skipping native FEM RK cost test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
        return;
    }

    let cases = [
        (IntegratorChoice::Heun, 3, 3, false),
        (IntegratorChoice::Rk4, 5, 5, false),
        (IntegratorChoice::Rk23, 4, 3, true),
        (IntegratorChoice::Rk45, 7, 6, true),
    ];

    for (integrator, expected_first_rhs, expected_second_rhs, expected_second_fsal) in cases {
        let mut plan = make_exchange_only_plan();
        plan.integrator = integrator;
        let mut backend = NativeFemBackend::create(&plan).expect("native fem create");

        let first = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("first native FEM RK step");
        assert_eq!(
            first.rhs_evals, expected_first_rhs,
            "unexpected first-step RHS count for {:?}",
            integrator
        );
        assert_eq!(
            first.demag_solves, 0,
            "exchange-only should not solve demag"
        );
        assert!(
            !first.demag_refreshed,
            "exchange-only should not refresh demag"
        );

        let second = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("second native FEM RK step");
        assert_eq!(
            second.rhs_evals, expected_second_rhs,
            "unexpected second-step RHS count for {:?}",
            integrator
        );
        assert_eq!(
            second.fsal_reused, expected_second_fsal,
            "unexpected FSAL reuse for {:?}",
            integrator
        );
        assert_eq!(
            second.demag_solves, 0,
            "exchange-only should not solve demag"
        );
        assert!(
            !second.demag_refreshed,
            "exchange-only should not refresh demag"
        );
    }
}

#[test]
fn native_fem_periodic_exchange_only_matches_cpu_reference_when_mfem_stack_is_available() {
    if !is_gpu_available() {
        eprintln!(
                "skipping native FEM periodic parity test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
        return;
    }

    let mut plan = make_exchange_only_plan();
    plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
        pair_id: "x_periodic".to_string(),
        source_marker: Some("x_min".to_string()),
        destination_marker: Some("x_max".to_string()),
        marker_a: 1,
        marker_b: 2,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: Some("x".to_string()),
        orientation: None,
        pairing_policy: None,
    }];
    plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
        pair_id: "x_periodic".to_string(),
        node_a: 0,
        node_b: 4,
    }];

    let (expected_m, expected_h_ex, expected_h_eff, expected_report) =
        cpu_reference_single_step(&plan);

    let mut backend = NativeFemBackend::create(&plan).expect("native periodic fem create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native periodic exchange-only fem step");
    let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
    let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
    let actual_h_eff = backend
        .copy_h_eff(plan.mesh.nodes.len())
        .expect("copy H_eff");

    assert_vector_field_close("periodic m", &actual_m, &expected_m, 5e-8, 1e-10);
    assert_vector_field_close("periodic H_ex", &actual_h_ex, &expected_h_ex, 5e-8, 1e-6);
    assert_vector_field_close("periodic H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);
    assert_vector_field_close(
        "periodic pair m",
        &actual_m[0..3],
        &actual_m[12..15],
        1e-12,
        1e-12,
    );
    assert_vector_field_close(
        "periodic pair H_ex",
        &actual_h_ex[0..3],
        &actual_h_ex[12..15],
        1e-12,
        1e-6,
    );

    assert_scalar_close(
        "periodic time_seconds",
        stats.time,
        expected_report.time_seconds,
        1e-12,
        1e-18,
    );
    assert_scalar_close(
        "periodic exchange_energy_joules",
        stats.e_ex,
        expected_report.exchange_energy_joules,
        5e-8,
        1e-18,
    );
}

#[test]
fn native_fem_periodic_consistent_mass_exchange_steps_when_mfem_stack_is_available() {
    if !is_gpu_available() {
        eprintln!(
                "skipping native FEM periodic consistent-mass test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
        return;
    }

    let mut plan = make_exchange_only_plan();
    plan.use_consistent_mass = Some(true);
    plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
        pair_id: "x_periodic".to_string(),
        source_marker: Some("x_min".to_string()),
        destination_marker: Some("x_max".to_string()),
        marker_a: 1,
        marker_b: 2,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: Some("x".to_string()),
        orientation: None,
        pairing_policy: None,
    }];
    plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
        pair_id: "x_periodic".to_string(),
        node_a: 0,
        node_b: 4,
    }];

    let mut backend =
        NativeFemBackend::create(&plan).expect("native periodic consistent fem create");
    let _stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native periodic consistent-mass exchange step");
    let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
    let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");

    assert_vector_field_close(
        "periodic consistent pair m",
        &actual_m[0..3],
        &actual_m[12..15],
        1e-12,
        1e-12,
    );
    assert_vector_field_close(
        "periodic consistent pair H_ex",
        &actual_h_ex[0..3],
        &actual_h_ex[12..15],
        1e-12,
        1e-6,
    );
}

#[test]
fn native_fem_zhang_li_step_matches_cpu_reference_when_mfem_stack_is_available() {
    if !is_gpu_available() {
        eprintln!("skipping native FEM Zhang-Li parity test: MFEM stack unavailable");
        return;
    }

    let mut plan = make_exchange_only_plan();
    plan.current_density = Some([8.0e10, 0.0, 0.0]);
    plan.stt_degree = Some(0.55);
    plan.stt_beta = Some(0.08);

    let (expected_m, _, expected_h_eff, expected_report) = cpu_reference_single_step(&plan);
    let mut backend = NativeFemBackend::create(&plan).expect("native fem create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native zhang-li fem step");
    let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
    let actual_h_eff = backend
        .copy_h_eff(plan.mesh.nodes.len())
        .expect("copy H_eff");

    assert_vector_field_close("m", &actual_m, &expected_m, 5e-8, 1e-10);
    assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);
    assert_scalar_close(
        "max_rhs_amplitude",
        stats.max_dm_dt,
        expected_report.max_rhs_amplitude,
        5e-8,
        1e-9,
    );
}

#[test]
fn native_fem_slonczewski_step_matches_cpu_reference_when_mfem_stack_is_available() {
    if !is_gpu_available() {
        eprintln!("skipping native FEM Slonczewski parity test: MFEM stack unavailable");
        return;
    }

    let mut plan = make_exchange_only_plan();
    plan.current_density = Some([0.0, 0.0, 1.4e11]);
    plan.stt_degree = Some(0.62);
    plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
    plan.stt_lambda = Some(1.8);
    plan.stt_epsilon_prime = Some(0.03);

    let (expected_m, _, expected_h_eff, expected_report) = cpu_reference_single_step(&plan);
    let mut backend = NativeFemBackend::create(&plan).expect("native fem create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native slonczewski fem step");
    let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
    let actual_h_eff = backend
        .copy_h_eff(plan.mesh.nodes.len())
        .expect("copy H_eff");

    assert_vector_field_close("m", &actual_m, &expected_m, 5e-8, 1e-10);
    assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);
    assert_scalar_close(
        "max_rhs_amplitude",
        stats.max_dm_dt,
        expected_report.max_rhs_amplitude,
        5e-8,
        1e-9,
    );
}
