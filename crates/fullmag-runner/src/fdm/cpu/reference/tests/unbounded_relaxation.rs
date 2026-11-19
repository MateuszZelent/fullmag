use super::*;

/// The accepted worker passes an unbounded horizon (+inf) for relaxation,
/// which stops on its torque tolerance or step limit instead of a clock.
#[test]
fn relaxation_accepts_an_unbounded_horizon() {
    let plan = make_relaxation_precession_test_plan();
    let result = execute_reference_fdm(&plan, f64::INFINITY, &[], None, None)
        .expect("relaxation must accept an unbounded horizon");
    assert_eq!(result.result.status, RunStatus::Completed);
    assert!(!result.result.steps.is_empty());
    assert!(result.result.steps.len() <= 10, "max_steps bounds the run");
    assert!(result.result.steps.iter().all(|step| step.time.is_finite()));
}

#[test]
fn time_evolution_still_requires_a_finite_horizon() {
    let plan = FdmPlanIR { relaxation: None, ..make_relaxation_precession_test_plan() };
    for horizon in [f64::INFINITY, f64::NAN, 0.0, -1e-12] {
        let error = execute_reference_fdm(&plan, horizon, &[], None, None)
            .err()
            .unwrap_or_else(|| panic!("horizon {horizon} must be rejected"));
        assert!(error.message.contains("finite and positive"), "{}", error.message);
    }
    let relax = make_relaxation_precession_test_plan();
    for horizon in [f64::NAN, 0.0, f64::NEG_INFINITY] {
        assert!(execute_reference_fdm(&relax, horizon, &[], None, None).is_err());
    }
}
