use fullmag_engine::{
    constant_z_field_llg_from_positive_x, CellSize, EffectiveFieldTerms, EvaluationRequest,
    ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters, SolverSession, TimeIntegrator,
    FDM_CPU_SOLVER_CHECKPOINT_SCHEMA_VERSION,
};

const GAMMA: f64 = 2.211e5;
const ALPHA: f64 = 0.02;
const FIELD_Z_APM: f64 = 1.0e4;
const FINAL_TIME: f64 = 2.0e-10;

fn macrospin_problem() -> ExchangeLlgProblem {
    ExchangeLlgProblem::with_terms(
        GridShape::new(1, 1, 1).expect("valid grid"),
        CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).expect("valid cell size"),
        MaterialParameters::new(8.0e5, 13.0e-12, ALPHA).expect("valid material"),
        LlgConfig::new(GAMMA, TimeIntegrator::ABM3).expect("valid ABM3 dynamics"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([0.0, 0.0, FIELD_Z_APM]),
            ..Default::default()
        },
    )
}

fn macrospin_error(steps: usize) -> f64 {
    let problem = macrospin_problem();
    let dt = FINAL_TIME / steps as f64;
    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .expect("valid state")
        .to_soa();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();
    for _ in 0..steps {
        let report = problem
            .step_soa_with_buffers_evaluation(
                &mut state,
                dt,
                &mut workspace,
                &mut buffers,
                EvaluationRequest::Minimal,
            )
            .expect("fixed-step ABM3 macrospin step");
        assert_eq!(report.dt_used, dt);
        assert!(!report.step_rejected);
        assert_eq!(report.suggested_next_dt, None);
    }

    let actual = state.magnetization().gather_to_aos()[0];
    let expected = constant_z_field_llg_from_positive_x(GAMMA, ALPHA, FIELD_Z_APM, FINAL_TIME);
    actual
        .iter()
        .zip(expected)
        .map(|(actual, expected)| (actual - expected).abs())
        .fold(0.0, f64::max)
}

#[test]
fn fixed_step_abm3_has_third_order_macrospin_convergence() {
    let errors = [64, 128, 256].map(macrospin_error);
    assert!(
        errors[0] > errors[1] && errors[1] > errors[2],
        "ABM3 errors must decrease monotonically: {errors:?}"
    );

    let observed_orders = [
        (errors[0] / errors[1]).log2(),
        (errors[1] / errors[2]).log2(),
    ];
    eprintln!("ABM3 errors={errors:?} observed_orders={observed_orders:?}");
    assert!(
        observed_orders.iter().all(|order| *order >= 2.8),
        "fixed-step ABM3 must demonstrate third-order convergence: errors={errors:?}, \
         observed_orders={observed_orders:?}"
    );
}

#[test]
fn fixed_step_abm3_reports_startup_steady_and_dt_reset_telemetry() {
    let problem = macrospin_problem();
    let dt = 1.0e-13;
    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .expect("valid state")
        .to_soa();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();

    for startup_index in 0..3 {
        let report = problem
            .step_soa_with_buffers_evaluation(
                &mut state,
                dt,
                &mut workspace,
                &mut buffers,
                EvaluationRequest::Minimal,
            )
            .expect("ABM3 startup step");
        let telemetry = report.abm3.expect("typed ABM3 startup telemetry");
        assert_eq!(telemetry.schema_version, 1);
        assert!(telemetry.startup_step, "startup index {startup_index}");
        assert!(!telemetry.history_reset_this_step);
        assert_eq!(telemetry.history_resets_total, 0);
        assert_eq!(telemetry.rhs_evaluations, 3);
    }

    let steady = problem
        .step_soa_with_buffers_evaluation(
            &mut state,
            dt,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect("steady ABM3 step")
        .abm3
        .expect("typed steady ABM3 telemetry");
    assert!(!steady.startup_step);
    assert!(!steady.history_reset_this_step);
    assert_eq!(steady.history_resets_total, 0);
    assert_eq!(steady.rhs_evaluations, 2);

    let reset = problem
        .step_soa_with_buffers_evaluation(
            &mut state,
            2.0 * dt,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect("ABM3 dt-reset startup step")
        .abm3
        .expect("typed ABM3 reset telemetry");
    assert!(reset.startup_step);
    assert!(reset.history_reset_this_step);
    assert_eq!(reset.history_resets_total, 1);
    assert_eq!(reset.rhs_evaluations, 3);
}

#[test]
fn fixed_step_abm3_checkpoint_round_trip_preserves_the_next_step() {
    let mut uninterrupted = SolverSession::new(macrospin_problem(), vec![[1.0, 0.0, 0.0]])
        .expect("uninterrupted session");
    let dt = 1.0e-13;
    for _ in 0..4 {
        uninterrupted.step(dt).expect("checkpoint seed step");
    }

    let checkpoint = uninterrupted.checkpoint();
    assert_eq!(
        checkpoint.schema_version,
        FDM_CPU_SOLVER_CHECKPOINT_SCHEMA_VERSION
    );
    assert_eq!(checkpoint.abm3.rhs_history.len(), 3);
    assert_eq!(checkpoint.abm3.rhs_times_seconds.len(), 3);
    assert_eq!(
        checkpoint.abm3.rhs_times_seconds[0],
        checkpoint.time_seconds
    );
    assert_eq!(
        checkpoint.abm3.rhs_times_seconds[1],
        checkpoint.time_seconds - dt
    );

    let serialized = serde_json::to_vec(&checkpoint).expect("serialize checkpoint");
    let decoded = serde_json::from_slice(&serialized).expect("deserialize checkpoint");
    let mut resumed =
        SolverSession::from_checkpoint(macrospin_problem(), decoded).expect("restore checkpoint");

    let uninterrupted_report = uninterrupted.step(dt).expect("uninterrupted next step");
    let resumed_report = resumed.step(dt).expect("resumed next step");
    assert_eq!(
        uninterrupted.state().transactional_state_digest(),
        resumed.state().transactional_state_digest()
    );
    assert_eq!(uninterrupted_report, resumed_report);
    assert!(!resumed_report.abm3.expect("ABM3 telemetry").startup_step);
}

#[test]
fn fixed_step_abm3_checkpoint_validation_is_fail_closed_and_transactional() {
    let mut source =
        SolverSession::new(macrospin_problem(), vec![[1.0, 0.0, 0.0]]).expect("source session");
    for _ in 0..4 {
        source.step(1.0e-13).expect("checkpoint seed step");
    }
    let checkpoint = source.checkpoint();
    let mut restored = SolverSession::from_checkpoint(macrospin_problem(), checkpoint.clone())
        .expect("valid restore");
    let before = restored.state().transactional_state_digest();

    let mut bad_schema = checkpoint.clone();
    bad_schema.schema_version = "fullmag.fdm.cpu.solver-checkpoint.v0".to_string();
    let error = restored
        .state_mut()
        .restore_solver_checkpoint(bad_schema)
        .expect_err("unknown checkpoint schema must fail");
    assert!(error
        .to_string()
        .contains("unsupported FDM CPU solver checkpoint schema"));
    assert_eq!(restored.state().transactional_state_digest(), before);

    let mut bad_time = checkpoint;
    bad_time.abm3.rhs_times_seconds[1] += 0.25e-13;
    let error = restored
        .state_mut()
        .restore_solver_checkpoint(bad_time)
        .expect_err("inconsistent ABM3 history time must fail");
    assert!(error.to_string().contains("ABM3 history time mismatch"));
    assert_eq!(restored.state().transactional_state_digest(), before);
}
