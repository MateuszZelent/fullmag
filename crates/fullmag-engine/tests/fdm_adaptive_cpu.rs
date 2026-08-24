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

        let mut persistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("persistent SoA seed")
            .to_soa();
        let persistent_before = persistent_soa.clone();
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
    }
}
