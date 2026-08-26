use fullmag_engine::{
    CellSize, EffectiveFieldTerms, ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters,
    OerstedCylinderConfig, TimeIntegrator,
};

fn norm(vector: [f64; 3]) -> f64 {
    vector.iter().map(|component| component * component).sum::<f64>().sqrt()
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
