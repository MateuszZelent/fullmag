use fullmag_engine::{
    CellSize, EffectiveFieldTerms, EngineError, EngineErrorCode, EvaluationRequest,
    ExchangeLlgProblem, ExternalStageTerms, GridShape, LlgConfig, MaterialParameters,
    TimeIntegrator,
};

const DT: f64 = 1.0e-13;

fn thermal_problem() -> ExchangeLlgProblem {
    let mut problem = ExchangeLlgProblem::with_terms(
        GridShape::new(2, 1, 1).expect("grid"),
        CellSize::new(2.0e-9, 2.0e-9, 2.0e-9).expect("cell"),
        MaterialParameters::new(8.0e5, 1.0e-30, 0.02).expect("material"),
        LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("LLG"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([0.0, 0.0, 1.0e4]),
            ..Default::default()
        },
    );
    problem.temperature = 300.0;
    problem.thermal_dt = DT;
    problem.thermal_seed = 0x5eed;
    problem
}

#[test]
fn rejected_nonfinite_step_is_atomic_and_retry_replays_the_same_thermal_interval() {
    let problem = thermal_problem();
    let clean_problem = thermal_problem();
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        .expect("state");
    let mut clean_state = state.clone();
    let before = state.clone();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();

    let error = problem
        .step_with_buffers_evaluation(
            &mut state,
            f64::NAN,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect_err("non-finite dt must fail before an attempt starts");

    assert_eq!(error.to_string(), "dt must be finite and positive");
    assert_eq!(error.code(), EngineErrorCode::InvalidTimestep);
    assert_eq!(state, before, "failed step mutated serialized solver state");
    assert_eq!(
        problem.thermal_step(),
        0,
        "failed step consumed thermal RNG"
    );

    problem
        .step_with_buffers_evaluation(
            &mut state,
            DT,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect("retry");
    let mut clean_workspace = clean_problem.create_workspace();
    let mut clean_buffers = clean_problem.create_integrator_buffers();
    clean_problem
        .step_with_buffers_evaluation(
            &mut clean_state,
            DT,
            &mut clean_workspace,
            &mut clean_buffers,
            EvaluationRequest::Minimal,
        )
        .expect("clean step");

    assert_eq!(state, clean_state, "retry changed the thermal trajectory");
    assert_eq!(problem.thermal_step(), 1);
    assert_eq!(clean_problem.thermal_step(), 1);
}

#[test]
fn persistent_soa_rejection_preserves_state_and_thermal_interval() {
    let problem = thermal_problem();
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        .expect("state")
        .to_soa();
    let before = state.clone();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();

    let error = problem
        .step_soa_with_buffers_evaluation(
            &mut state,
            f64::INFINITY,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect_err("non-finite dt must fail before an attempt starts");

    assert_eq!(error.to_string(), "dt must be finite and positive");
    assert_eq!(error.code(), EngineErrorCode::InvalidTimestep);
    assert_eq!(state, before);
    assert_eq!(problem.thermal_step(), 0);
}

#[test]
fn nonfinite_coupled_stage_terms_are_typed_and_do_not_commit_state() {
    let problem = thermal_problem();
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        .expect("state");
    let before = state.clone();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();

    let error = problem
        .heun_step_with_external_stage_terms_and_lte(
            &mut state,
            DT,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
            |magnetization, _time_s, _budget| {
                Ok(ExternalStageTerms {
                    additional_field_apm: vec![[f64::NAN, 0.0, 0.0]; magnetization.len()],
                    direct_torque_per_s: vec![[0.0; 3]; magnetization.len()],
                })
            },
        )
        .expect_err("non-finite coupled stage terms must fail before commit");

    assert_eq!(error.code(), EngineErrorCode::NaNValue);
    assert_eq!(state, before);
    assert_eq!(problem.thermal_step(), 0);
}

#[test]
fn coupled_heun_final_stage_failure_rolls_back_state_and_thermal_interval() {
    let problem = thermal_problem();
    let clean_problem = thermal_problem();
    let initial = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let mut state = problem.new_state(initial.clone()).expect("state");
    let mut clean_state = clean_problem.new_state(initial).expect("clean state");
    let before = state.clone();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();
    let mut evaluations = 0;

    let error = problem
        .heun_step_with_external_stage_terms_and_lte(
            &mut state,
            DT,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
            |magnetization, _time_s, _budget| {
                evaluations += 1;
                if evaluations == 3 {
                    return Err(EngineError::with_code(
                        EngineErrorCode::CoupledSolverFailure,
                        "injected_final_stage_failure",
                    ));
                }
                Ok(ExternalStageTerms {
                    additional_field_apm: vec![[0.0; 3]; magnetization.len()],
                    direct_torque_per_s: vec![[0.0; 3]; magnetization.len()],
                })
            },
        )
        .expect_err("final coupled stage must fail");

    assert_eq!(error.to_string(), "injected_final_stage_failure");
    assert_eq!(error.code(), EngineErrorCode::CoupledSolverFailure);
    assert_eq!(
        evaluations, 3,
        "failure must occur at the final stage boundary"
    );
    assert_eq!(state, before, "failed coupled step mutated solver state");
    assert_eq!(
        problem.thermal_step(),
        0,
        "failed coupled step consumed RNG"
    );

    let zero_terms = |magnetization: &[[f64; 3]], _time_s, _budget| {
        Ok(ExternalStageTerms {
            additional_field_apm: vec![[0.0; 3]; magnetization.len()],
            direct_torque_per_s: vec![[0.0; 3]; magnetization.len()],
        })
    };
    problem
        .heun_step_with_external_stage_terms_and_lte(
            &mut state,
            DT,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
            zero_terms,
        )
        .expect("retry");
    let mut clean_workspace = clean_problem.create_workspace();
    let mut clean_buffers = clean_problem.create_integrator_buffers();
    clean_problem
        .heun_step_with_external_stage_terms_and_lte(
            &mut clean_state,
            DT,
            &mut clean_workspace,
            &mut clean_buffers,
            EvaluationRequest::Minimal,
            zero_terms,
        )
        .expect("clean coupled step");

    assert_eq!(
        state, clean_state,
        "coupled retry changed thermal trajectory"
    );
    assert_eq!(problem.thermal_step(), 1);
    assert_eq!(clean_problem.thermal_step(), 1);
}
