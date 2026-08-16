use fullmag_engine::{
    CellSize, EffectiveFieldTerms, ExchangeLlgProblem, GridShape, LlgConfig,
    MaterialParameters, TimeIntegrator, MU0,
};

#[test]
fn static_field_map_contributes_to_external_field_and_zeeman_energy() {
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
    .with_static_external_field(Some(vec![[0.0, 0.0, 1.0e-3 / MU0], [0.0, 0.0, 2.0e-3 / MU0]]))
    .expect("static field map matches grid");

    let state = problem.uniform_state([0.0, 0.0, 1.0]).expect("valid state");
    let observables = problem.observe(&state).expect("observable evaluation");

    assert_eq!(observables.external_field[0][2], 1.0e-3 / MU0);
    assert_eq!(observables.external_field[1][2], 2.0e-3 / MU0);
    assert_eq!(observables.effective_field, observables.external_field);

    let expected_energy = -8.0e5 * 1.0e-27 * 3.0e-3;
    assert!((observables.external_energy_joules - expected_energy).abs() < 1.0e-36);
}
