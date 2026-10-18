use fullmag_engine::{
    CellSize, EffectiveFieldTerms, EngineErrorCode, EvaluationRequest, ExchangeLlgProblem,
    ExternalStageTerms, GridShape, LlgConfig, MaterialParameters, TimeIntegrator,
};

fn problem(cells: usize, alpha: f64) -> ExchangeLlgProblem {
    ExchangeLlgProblem::with_terms(
        GridShape::new(cells, 1, 1).expect("grid"),
        CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).expect("cell"),
        MaterialParameters::new(8.0e5, 1.0e-30, alpha).expect("material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("LLG"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            ..Default::default()
        },
    )
}

#[test]
fn gilbert_stage_uses_local_damping_and_preserves_field_and_source_observations() {
    let mut problem = problem(3, 0.1);
    problem.alpha_field = Some(vec![0.5, 1.0, 0.0]);
    let m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let source = vec![[0.0, 2.0, 0.0], [0.0, 0.0, 3.0], [4.0, 0.0, 0.0]];
    let field = vec![[1.0, -2.0, 3.0]; 3];
    let expected = [[0.0, 1.6, 0.8], [1.5, 0.0, 1.5], [4.0, 0.0, 0.0]];
    for precession in [true, false] {
        problem.dynamics.precession_enabled = precession;
        let terms = problem
            .external_stage_terms_from_gilbert_source(&m, field.clone(), source.clone())
            .expect("converted terms");
        assert_eq!(terms.additional_field_apm, field);
        for (actual, expected) in terms.direct_torque_per_s.iter().zip(expected) {
            for axis in 0..3 {
                assert!((actual[axis] - expected[axis]).abs() < 1.0e-14);
            }
        }
    }
    assert_eq!(
        source,
        vec![[0.0, 2.0, 0.0], [0.0, 0.0, 3.0], [4.0, 0.0, 0.0]]
    );
    let zeros = problem
        .external_stage_terms_from_gilbert_source(&m, field.clone(), vec![[0.0; 3]; 3])
        .expect("zero source");
    assert_eq!(zeros.direct_torque_per_s, vec![[0.0; 3]; 3]);
    for (trial, field, source) in [
        (&m[..2], field.clone(), source.clone()),
        (&m[..], field[..2].to_vec(), source.clone()),
        (&m[..], field.clone(), source[..2].to_vec()),
    ] {
        assert_eq!(
            problem
                .external_stage_terms_from_gilbert_source(trial, field, source)
                .expect_err("mismatched grid must fail")
                .code(),
            EngineErrorCode::InvalidInput
        );
    }
}

fn equivalent_field_terms(
    problem: &ExchangeLlgProblem,
    m: &[[f64; 3]],
    as_gilbert_source: bool,
) -> fullmag_engine::Result<ExternalStageTerms> {
    let h = [0.4, -0.7, 1.1];
    if as_gilbert_source {
        // Independent field identity T_G = -gamma0 m x H, gamma0 = 1 here.
        let source = m
            .iter()
            .map(|m| {
                [
                    -(m[1] * h[2] - m[2] * h[1]),
                    -(m[2] * h[0] - m[0] * h[2]),
                    -(m[0] * h[1] - m[1] * h[0]),
                ]
            })
            .collect();
        problem.external_stage_terms_from_gilbert_source(m, vec![[0.0; 3]; m.len()], source)
    } else {
        Ok(ExternalStageTerms {
            additional_field_apm: vec![h; m.len()],
            direct_torque_per_s: vec![[0.0; 3]; m.len()],
        })
    }
}

#[test]
fn gilbert_source_matches_independent_field_rhs_through_heun_and_ars_trials() {
    for ars in [false, true] {
        let problem = problem(1, 0.6);
        let initial = vec![[0.6, 0.0, 0.8]];
        let mut source_state = problem.new_state(initial.clone()).expect("source state");
        let mut field_state = problem.new_state(initial).expect("field state");
        let mut source_ws = problem.create_workspace();
        let mut field_ws = problem.create_workspace();
        let mut source_buffers = problem.create_integrator_buffers();
        let mut field_buffers = problem.create_integrator_buffers();
        for _ in 0..4 {
            for (state, ws, buffers, as_source) in [
                (&mut source_state, &mut source_ws, &mut source_buffers, true),
                (&mut field_state, &mut field_ws, &mut field_buffers, false),
            ] {
                if ars {
                    problem
                        .coupled_imex_ark2_fixed_step_with_external_stage_terms(
                            state,
                            0.02,
                            ws,
                            buffers,
                            EvaluationRequest::Minimal,
                            |m, _time, _stage| equivalent_field_terms(&problem, m, as_source),
                        )
                        .expect("ARS trial");
                } else {
                    problem
                        .heun_step_with_external_stage_terms_and_lte(
                            state,
                            0.02,
                            ws,
                            buffers,
                            EvaluationRequest::Minimal,
                            |m, _time, _budget| equivalent_field_terms(&problem, m, as_source),
                        )
                        .expect("Heun trial");
                }
            }
            assert_eq!(source_state.time_seconds, field_state.time_seconds);
            for (source, field) in source_state
                .magnetization()
                .iter()
                .zip(field_state.magnetization())
            {
                for axis in 0..3 {
                    assert!(
                        (source[axis] - field[axis]).abs() < 2.0e-13,
                        "Gilbert source differs from independent field RHS: ars={ars}, axis={axis}"
                    );
                }
            }
        }
    }
}
