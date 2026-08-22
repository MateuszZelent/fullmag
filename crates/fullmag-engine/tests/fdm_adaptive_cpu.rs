use fullmag_engine::{
    AdaptiveStepConfig, CellSize, EffectiveFieldTerms, EvaluationRequest, ExchangeLlgProblem,
    GridShape, LlgConfig, MaterialParameters, TimeIntegrator,
};

const INITIAL_DT: f64 = 1.0;

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
        let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
        let mut aos_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let report = problem
            .step_with_buffers_evaluation(
                &mut aos,
                INITIAL_DT,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Minimal,
            )
            .expect("AoS adaptive step must eventually accept");
        assert!(
            report.dt_used < INITIAL_DT,
            "{integrator:?} AoS did not retry"
        );
        assert_eq!(aos.time_seconds, report.dt_used);

        let mut persistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("SoA seed")
            .to_soa();
        let mut soa_ws = problem.create_workspace();
        let mut soa_bufs = problem.create_integrator_buffers();
        let report = problem
            .step_soa_with_buffers_evaluation(
                &mut persistent_soa,
                INITIAL_DT,
                &mut soa_ws,
                &mut soa_bufs,
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
fn fdm_adaptive_cpu_preserves_aos_and_soa_states_on_terminal_errors() {
    for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
        for (max_error, dt_min, dt_max, expected) in [
            (f64::NAN, 1.0e-6, INITIAL_DT, "non_finite_adaptive_error"),
            (1.0e-30, INITIAL_DT, INITIAL_DT, "dt_min_exhausted"),
        ] {
            let problem = adaptive_problem(integrator, max_error, dt_min, dt_max);
            let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
            let aos_before = aos.clone();
            let mut aos_ws = problem.create_workspace();
            let mut aos_bufs = problem.create_integrator_buffers();
            let error = problem
                .step_with_buffers_evaluation(
                    &mut aos,
                    INITIAL_DT,
                    &mut aos_ws,
                    &mut aos_bufs,
                    EvaluationRequest::Minimal,
                )
                .expect_err("AoS terminal adaptive error expected");
            assert_eq!(error.to_string(), expected);
            assert_eq!(aos, aos_before);

            let mut persistent_soa = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("SoA seed")
                .to_soa();
            let soa_before = persistent_soa.clone();
            let mut soa_ws = problem.create_workspace();
            let mut soa_bufs = problem.create_integrator_buffers();
            let error = problem
                .step_soa_with_buffers_evaluation(
                    &mut persistent_soa,
                    INITIAL_DT,
                    &mut soa_ws,
                    &mut soa_bufs,
                    EvaluationRequest::Minimal,
                )
                .expect_err("persistent SoA terminal adaptive error expected");
            assert_eq!(error.to_string(), expected);
            assert_eq!(persistent_soa, soa_before);
        }
    }
}

#[test]
fn fdm_adaptive_cpu_propagates_injected_nonfinite_error_norms() {
    for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
        for injected_error in [f64::NAN, f64::INFINITY] {
            let problem = adaptive_problem(integrator, 1.0, 1.0e-9, INITIAL_DT);

            let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
            let aos_before = aos.clone();
            let mut aos_ws = problem.create_workspace();
            let mut aos_bufs = problem.create_integrator_buffers();
            aos_bufs.adaptive_error_override = Some(injected_error);
            let error = problem
                .step_with_buffers_evaluation(
                    &mut aos,
                    1.0e-6,
                    &mut aos_ws,
                    &mut aos_bufs,
                    EvaluationRequest::Minimal,
                )
                .expect_err("injected AoS error norm must be terminal");
            assert_eq!(error.to_string(), "non_finite_adaptive_error");
            assert_eq!(aos, aos_before);

            let mut persistent_soa = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("SoA seed")
                .to_soa();
            let soa_before = persistent_soa.clone();
            let mut soa_ws = problem.create_workspace();
            let mut soa_bufs = problem.create_integrator_buffers();
            soa_bufs.adaptive_error_override = Some(injected_error);
            let error = problem
                .step_soa_with_buffers_evaluation(
                    &mut persistent_soa,
                    1.0e-6,
                    &mut soa_ws,
                    &mut soa_bufs,
                    EvaluationRequest::Minimal,
                )
                .expect_err("injected persistent-SoA error norm must be terminal");
            assert_eq!(error.to_string(), "non_finite_adaptive_error");
            assert_eq!(persistent_soa, soa_before);
        }
    }
}
