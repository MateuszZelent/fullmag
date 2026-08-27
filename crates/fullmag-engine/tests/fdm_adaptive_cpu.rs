use fullmag_engine::{
    constant_z_field_llg_from_positive_x, AdaptiveAttemptDecision, AdaptiveStepConfig,
    AdaptiveStepController, AdaptiveStepDecision, CellSize, EffectiveFieldTerms, EvaluationRequest,
    ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters, TimeIntegrator,
    FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION, MAX_ADAPTIVE_ATTEMPT_RECORDS,
};

const INITIAL_DT: f64 = 1.0;

#[test]
fn public_adaptive_controller_is_versioned_and_bounded() {
    let config = AdaptiveStepConfig {
        max_error: 1.0,
        dt_min: 1.0e-6,
        dt_max: 1.0e-2,
        headroom: 0.2,
        rtol: 0.0,
        growth_limit: 3.0,
        shrink_limit: 0.2,
    };
    let mut controller = AdaptiveStepController::new(4, config, None).with_max_rejected_attempts(2);
    assert_eq!(
        controller.policy_version(),
        FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION
    );
    assert_eq!(controller.previous_error(), None);
    assert!(matches!(
        controller.decide(1.0e-3, 4.0),
        AdaptiveStepDecision::Retry(next) if next < 1.0e-3
    ));
    assert_eq!(controller.rejected_attempts(), 1);
    assert_eq!(controller.previous_error(), None);
    let next = match controller.decide(2.0e-4, 4.0) {
        AdaptiveStepDecision::Retry(next) => next,
        other => panic!("expected second retry, got {other:?}"),
    };
    assert!(next < 2.0e-4);
    assert_eq!(controller.rejected_attempts(), 2);
    assert_eq!(
        controller.decide(next, 4.0),
        AdaptiveStepDecision::RetryLimitExhausted
    );

    let mut accepted = AdaptiveStepController::new(4, config, Some(0.5));
    assert!(matches!(
        accepted.decide(1.0e-3, 0.25),
        AdaptiveStepDecision::Accepted(next) if next.is_finite()
    ));
    assert_eq!(accepted.previous_error(), Some(0.25));
}

#[test]
fn adaptive_attempt_rhs_counts_are_measured_at_the_six_controller_boundaries() {
    let source = include_str!("../src/fdm/cpu/integrators.rs");
    assert_eq!(
        source.matches("rhs_evals.finish()").count(),
        6,
        "each RK23/RK45 AoS, buffer-SoA and state-SoA controller boundary must consume an actual per-attempt RHS counter",
    );
    assert_eq!(
        source.matches("let mut adaptive_controller").count(),
        6,
        "all six production adaptive boundaries must own the public controller",
    );
    for (function, expected_rhs_evals) in [
        ("rk23_step_buf", 4),
        ("rk23_step_soa_buf", 4),
        ("rk45_step_buf", 7),
        ("rk45_step_soa_buf", 7),
        ("rk23_step_soa_state_buf", 4),
        ("rk45_step_soa_state_buf", 7),
    ] {
        let marker = format!("pub(crate) fn {function}(");
        let body = source
            .split_once(&marker)
            .unwrap_or_else(|| panic!("missing adaptive integrator {function}"))
            .1
            .split_once("    pub(crate) fn ")
            .map_or_else(|| source, |(body, _)| body);
        assert_eq!(
            body.matches("self.llg_rhs_").count(),
            expected_rhs_evals,
            "unexpected stage-RHS call count in {function}",
        );
        assert_eq!(
            body.matches("rhs_evals.record()").count(),
            expected_rhs_evals,
            "every stage-RHS call in {function} must update the attempt counter",
        );
    }
}

fn adaptive_problem(
    integrator: TimeIntegrator,
    max_error: f64,
    dt_min: f64,
    dt_max: f64,
) -> ExchangeLlgProblem {
    ExchangeLlgProblem::with_terms(
        GridShape::new(1, 1, 1).expect("valid grid"),
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 1.0e-30, 0.1).expect("valid material"),
        LlgConfig::new(100.0, integrator)
            .expect("valid LLG configuration")
            .with_adaptive(AdaptiveStepConfig {
                max_error,
                dt_min,
                dt_max,
                headroom: 0.2,
                rtol: 0.0,
                growth_limit: 3.0,
                shrink_limit: 0.2,
            }),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([0.0, 1.0, 0.0]),
            ..Default::default()
        },
    )
}

#[test]
fn fdm_adaptive_cpu_retries_with_smaller_dt_for_rk23_and_rk45() {
    for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
        let problem = adaptive_problem(integrator, 1.0e-3, 1.0e-6, INITIAL_DT);
        let mut nonpersistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("nonpersistent SoA state");
        let mut nonpersistent_ws = problem.create_workspace();
        let mut nonpersistent_bufs = problem.create_integrator_buffers();
        let report = problem
            .step_with_buffers_evaluation(
                &mut nonpersistent_soa,
                INITIAL_DT,
                &mut nonpersistent_ws,
                &mut nonpersistent_bufs,
                EvaluationRequest::Minimal,
            )
            .expect("nonpersistent SoA adaptive step must eventually accept");
        assert!(
            report.dt_used < INITIAL_DT,
            "{integrator:?} nonpersistent SoA did not retry"
        );
        assert_eq!(nonpersistent_soa.time_seconds, report.dt_used);

        let mut persistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("persistent SoA seed")
            .to_soa();
        let mut persistent_ws = problem.create_workspace();
        let mut persistent_bufs = problem.create_integrator_buffers();
        let report = problem
            .step_soa_with_buffers_evaluation(
                &mut persistent_soa,
                INITIAL_DT,
                &mut persistent_ws,
                &mut persistent_bufs,
                EvaluationRequest::Minimal,
            )
            .expect("persistent SoA adaptive step must eventually accept");
        assert!(
            report.dt_used < INITIAL_DT,
            "{integrator:?} persistent SoA did not retry"
        );
        assert_eq!(persistent_soa.time_seconds, report.dt_used);
    }
}

#[test]
fn fdm_adaptive_cpu_preserves_public_states_on_terminal_errors() {
    for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
        let problem = adaptive_problem(integrator, 1.0e-30, INITIAL_DT, INITIAL_DT);
        let mut nonpersistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("nonpersistent SoA state");
        let nonpersistent_before = nonpersistent_soa.clone();
        let nonpersistent_thermal_step_before = problem.thermal_step();
        let mut nonpersistent_ws = problem.create_workspace();
        let mut nonpersistent_bufs = problem.create_integrator_buffers();
        let error = problem
            .step_with_buffers_evaluation(
                &mut nonpersistent_soa,
                INITIAL_DT,
                &mut nonpersistent_ws,
                &mut nonpersistent_bufs,
                EvaluationRequest::Minimal,
            )
            .expect_err("nonpersistent SoA terminal error expected");
        assert_eq!(error.to_string(), "dt_min_exhausted");
        assert_eq!(nonpersistent_soa, nonpersistent_before);
        assert_eq!(problem.thermal_step(), nonpersistent_thermal_step_before);

        let mut persistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("persistent SoA seed")
            .to_soa();
        let persistent_before = persistent_soa.clone();
        let persistent_thermal_step_before = problem.thermal_step();
        let mut persistent_ws = problem.create_workspace();
        let mut persistent_bufs = problem.create_integrator_buffers();
        let error = problem
            .step_soa_with_buffers_evaluation(
                &mut persistent_soa,
                INITIAL_DT,
                &mut persistent_ws,
                &mut persistent_bufs,
                EvaluationRequest::Minimal,
            )
            .expect_err("persistent SoA terminal error expected");
        assert_eq!(error.to_string(), "dt_min_exhausted");
        assert_eq!(persistent_soa, persistent_before);
        assert_eq!(problem.thermal_step(), persistent_thermal_step_before);
    }
}

#[test]
fn fdm_adaptive_cpu_publishes_bounded_retry_and_accept_trace() {
    let problem = adaptive_problem(TimeIntegrator::RK23, 1.0e-3, 1.0e-6, INITIAL_DT);
    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .expect("adaptive state");
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();

    problem
        .step_with_buffers_evaluation(
            &mut state,
            INITIAL_DT,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect("adaptive step must retry and accept");

    let attempts = buffers.adaptive_attempts();
    assert!(
        attempts.len() >= 2,
        "fixture must exercise retry and acceptance"
    );
    assert!(attempts.len() <= MAX_ADAPTIVE_ATTEMPT_RECORDS);
    assert!(attempts.iter().all(|attempt| {
        attempt.controller_policy_version == FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION
    }));
    assert_eq!(attempts[0].attempt, 1);
    assert_eq!(attempts[0].decision, AdaptiveAttemptDecision::Retry);
    assert!(attempts.iter().all(|attempt| attempt.rhs_evals == 4));
    assert!(attempts[0].dt_next < attempts[0].dt_attempt);
    assert_eq!(
        attempts.last().expect("accepted attempt").decision,
        AdaptiveAttemptDecision::Accepted
    );
    assert_eq!(
        buffers.adaptive_rejected_attempts(),
        attempts.len() as u32 - 1
    );
    assert_eq!(buffers.adaptive_accepted_attempts(), 1);
}

#[test]
fn fdm_adaptive_cpu_matches_constant_field_llg_oracle() {
    const GAMMA: f64 = 2.211e5;
    const ALPHA: f64 = 0.1;
    const FIELD_Z_APM: f64 = 1.0e4;
    const FINAL_TIME: f64 = 1.0e-9;

    for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
        let problem = ExchangeLlgProblem::with_terms(
            GridShape::new(1, 1, 1).expect("grid"),
            CellSize::new(1.0, 1.0, 1.0).expect("cell"),
            MaterialParameters::new(1.0, 1.0e-30, ALPHA).expect("material"),
            LlgConfig::new(GAMMA, integrator)
                .expect("LLG")
                .with_adaptive(AdaptiveStepConfig {
                    max_error: 1.0e-10,
                    dt_min: 1.0e-15,
                    dt_max: 2.0e-10,
                    headroom: 0.8,
                    rtol: 1.0e-8,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                }),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.0, 0.0, FIELD_Z_APM]),
                ..Default::default()
            },
        );
        let mut state = problem.uniform_state([1.0, 0.0, 0.0]).expect("state");
        let mut workspace = problem.create_workspace();
        let mut buffers = problem.create_integrator_buffers();
        let mut dt: f64 = 2.0e-10;
        while state.time_seconds < FINAL_TIME {
            let remaining = FINAL_TIME - state.time_seconds;
            let report = problem
                .step_with_buffers_evaluation(
                    &mut state,
                    dt.min(remaining),
                    &mut workspace,
                    &mut buffers,
                    EvaluationRequest::Minimal,
                )
                .expect("adaptive oracle step");
            dt = report.suggested_next_dt.unwrap_or(report.dt_used);
        }

        let expected = constant_z_field_llg_from_positive_x(GAMMA, ALPHA, FIELD_Z_APM, FINAL_TIME);
        let actual = state.magnetization()[0];
        let error = actual
            .iter()
            .zip(expected)
            .map(|(actual, expected)| (actual - expected).abs())
            .fold(0.0_f64, f64::max);
        assert!(
            error < 2.0e-7,
            "{integrator:?} constant-field LLG oracle error {error:.6e}: actual={actual:?}, expected={expected:?}"
        );
    }
}
