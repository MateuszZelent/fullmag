use fullmag_engine::{
    CellSize, EffectiveFieldTerms, ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters,
    OerstedCylinderConfig, RegionalFieldDriveTerm, TimeIntegrator,
};

fn norm(vector: [f64; 3]) -> f64 {
    vector
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt()
}

#[test]
fn soa_step_report_counts_oersted_field_once() {
    let problem = ExchangeLlgProblem::with_terms(
        GridShape::new(1, 1, 1).expect("valid grid"),
        CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).expect("valid cell size"),
        MaterialParameters::new(8.0e5, 1.0e-11, 0.02).expect("valid material"),
        LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid dynamics"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            oersted_cylinder: Some(OerstedCylinderConfig {
                current: 1.0e-6,
                radius: 0.25e-9,
                center: [0.0, 0.5e-9, 0.5e-9],
                axis: [0.0, 0.0, 1.0],
                time_dep_kind: 0,
                time_dep_freq: 0.0,
                time_dep_phase: 0.0,
                time_dep_offset: 0.0,
                time_dep_t_on: 0.0,
                time_dep_t_off: 0.0,
            }),
            ..Default::default()
        },
    );
    let expected_field = problem.oersted_field_at_time(1.0e-9)[0];
    let expected_amplitude = norm(expected_field);
    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .expect("valid state")
        .to_soa();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();

    let report = problem
        .step_soa_with_buffers_evaluation(
            &mut state,
            1.0e-9,
            &mut workspace,
            &mut buffers,
            fullmag_engine::EvaluationRequest::Full,
        )
        .expect("SoA step must succeed");

    assert!(
        (report.max_effective_field_amplitude - expected_amplitude).abs()
            <= expected_amplitude * 1.0e-12,
        "SoA report must contain one Oersted field contribution: expected {expected_amplitude:e}, got {}",
        report.max_effective_field_amplitude
    );
}

#[test]
fn soa_fast_path_fails_closed_for_spatial_material_fields() {
    let problem = ExchangeLlgProblem::with_terms(
        GridShape::new(2, 1, 1).expect("valid grid"),
        CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).expect("valid cell size"),
        MaterialParameters::new(8.0e5, 1.0e-11, 0.02).expect("valid material"),
        LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid dynamics"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            ..Default::default()
        },
    )
    .with_spatial_fields(
        Some(vec![8.0e5, 9.0e5]),
        Some(vec![1.0e-11, 2.0e-11]),
        Some(vec![0.02, 0.03]),
    )
    .expect("spatial material fields match the grid");

    assert!(!problem.soa_fast_path_supported());
    assert_eq!(
        problem.soa_fast_path_rejection_reason(),
        Some("spatial_saturation_magnetisation")
    );

    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .expect("valid state")
        .to_soa();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();
    let error = problem
        .step_soa_with_buffers_evaluation(
            &mut state,
            1.0e-12,
            &mut workspace,
            &mut buffers,
            fullmag_engine::EvaluationRequest::Minimal,
        )
        .expect_err("SoA must reject unsupported spatial material fields");
    assert!(error
        .to_string()
        .contains("CPU SoA fast path unavailable: spatial_saturation_magnetisation"));
}

#[test]
fn inactive_zero_ms_is_allowed_but_active_zero_ms_is_rejected() {
    let mut problem = ExchangeLlgProblem::with_terms_and_mask(
        GridShape::new(2, 1, 1).expect("valid grid"),
        CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).expect("valid cell size"),
        MaterialParameters::new(8.0e5, 1.0e-11, 0.02).expect("valid material"),
        LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid dynamics"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            ..Default::default()
        },
        Some(vec![false, true]),
    )
    .expect("masked problem should build")
    .with_spatial_fields(Some(vec![0.0, 8.0e5]), None, Some(vec![0.02, 0.02]))
    .expect("zero Ms is valid outside the active domain");
    problem.temperature = 300.0;
    problem.thermal_dt = 2.0e-13;
    let mut workspace = problem.create_workspace();
    let field = problem.effective_field_from_vectors_ws(&[[0.0; 3]; 2], &mut workspace);
    assert_eq!(field[0], [0.0; 3]);
    assert!(field[1].iter().all(|component| component.is_finite()));

    let active_zero = ExchangeLlgProblem::with_terms_and_mask(
        GridShape::new(2, 1, 1).expect("valid grid"),
        CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).expect("valid cell size"),
        MaterialParameters::new(8.0e5, 1.0e-11, 0.02).expect("valid material"),
        LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid dynamics"),
        EffectiveFieldTerms::default(),
        Some(vec![true, true]),
    )
    .expect("masked problem should build")
    .with_spatial_fields(Some(vec![0.0, 8.0e5]), None, None)
    .expect_err("zero Ms on an active cell must be rejected");
    assert!(active_zero
        .to_string()
        .contains("ms_field contains zero on an active cell"));
}

#[test]
fn aos_and_soa_effective_fields_include_regional_drive_once() {
    let mut problem = ExchangeLlgProblem::with_terms(
        GridShape::new(2, 1, 1).expect("valid grid"),
        CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).expect("valid cell size"),
        MaterialParameters::new(8.0e5, 1.0e-11, 0.02).expect("valid material"),
        LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid dynamics"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            ..Default::default()
        },
    );
    problem.regional_field_drives.push(RegionalFieldDriveTerm {
        basis_field: vec![[1.0, 2.0, 3.0], [-4.0, 5.0, -6.0]],
        waveform: fullmag_ir::TimeDependenceIR::Constant,
        time_offset_s: 0.0,
        enabled: true,
    });
    let state = problem.uniform_state([1.0, 0.0, 0.0]).expect("valid state");
    let aos_field = problem
        .effective_field(&state)
        .expect("AoS effective field must be available");
    let soa_state = state.to_soa();
    let mut soa_field = fullmag_engine::VectorFieldSoA::zeros(2);
    let mut soa_workspace = problem.create_workspace();
    problem.effective_field_into_soa_ws_at(
        soa_state.magnetization(),
        state.time_seconds,
        &mut soa_workspace,
        &mut soa_field,
    );

    assert_eq!(aos_field, soa_field.gather_to_aos());
}
