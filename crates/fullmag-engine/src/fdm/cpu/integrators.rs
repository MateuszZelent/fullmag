//! Time integrator methods for ExchangeLlgProblem.
//!
//! All methods are `impl ExchangeLlgProblem` — Rust allows splitting impls
//! across multiple files within the same crate.

use crate::vector::{add, cross, norm, normalized, scale};
use crate::{
    AdaptiveAttemptDecision, AdaptiveAttemptReason, AdaptiveAttemptRecord, AdaptiveStepController,
    AdaptiveStepDecision, CoupledImexArk2Stage, CoupledImexArk2Tableau, EvaluationRequest,
    ExchangeLlgProblem, ExchangeLlgState, ExchangeLlgStateSoA, ExternalStageTerms, FftWorkspace,
    IntegratorBuffers, Result, RhsEvaluation, StepReport, Vector3, VectorFieldSoA,
};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

type AdaptiveDecision = AdaptiveStepDecision;

#[cfg(test)]
fn decide_adaptive_step(
    order_est: i32,
    dt: f64,
    error: f64,
    previous_error: Option<f64>,
    cfg: crate::AdaptiveStepConfig,
) -> AdaptiveDecision {
    AdaptiveStepController::new(order_est, cfg, previous_error).decide(dt, error)
}

fn decide_adaptive_attempt(
    dt: f64,
    error: f64,
    rhs_evals: u32,
    bufs: &mut IntegratorBuffers,
    controller: &mut AdaptiveStepController,
) -> AdaptiveDecision {
    #[cfg(test)]
    bufs.record_adaptive_attempt_for_tests(dt);
    let decision = controller.decide(dt, error);
    let (published_decision, reason, dt_next) = match decision {
        AdaptiveDecision::Accepted(next) => (
            AdaptiveAttemptDecision::Accepted,
            AdaptiveAttemptReason::WithinTolerance,
            next,
        ),
        AdaptiveDecision::Retry(next) => (
            AdaptiveAttemptDecision::Retry,
            AdaptiveAttemptReason::ErrorAboveTolerance,
            next,
        ),
        AdaptiveDecision::DtMinExhausted => (
            AdaptiveAttemptDecision::Failed,
            AdaptiveAttemptReason::DtMinExhausted,
            dt,
        ),
        AdaptiveDecision::NonFinite(_) => (
            AdaptiveAttemptDecision::Failed,
            AdaptiveAttemptReason::NonFiniteError,
            dt,
        ),
        AdaptiveDecision::RetryLimitExhausted => (
            AdaptiveAttemptDecision::Failed,
            AdaptiveAttemptReason::RetryLimitExhausted,
            dt,
        ),
    };
    bufs.record_adaptive_attempt(AdaptiveAttemptRecord {
        controller_policy_version: controller.policy_version(),
        attempt: 0,
        dt_attempt: dt,
        normalized_error: error,
        decision: published_decision,
        reason,
        dt_next,
        rhs_evals,
    });
    decision
}

#[derive(Default)]
struct AttemptRhsCounter {
    count: u32,
}

impl AttemptRhsCounter {
    #[inline]
    fn record(&mut self) {
        self.count += 1;
    }

    #[inline]
    fn finish(self) -> u32 {
        self.count
    }
}

#[cfg(feature = "parallel")]
fn max_error_preserving_nonfinite(left: f64, right: f64) -> f64 {
    if !left.is_finite() {
        left
    } else if !right.is_finite() {
        right
    } else {
        left.max(right)
    }
}

#[cfg(test)]
mod adaptive_decision_tests {
    use super::*;

    fn test_config() -> crate::AdaptiveStepConfig {
        crate::AdaptiveStepConfig {
            max_error: 1.0,
            dt_min: 1e-6,
            dt_max: 1e-2,
            headroom: 0.2,
            rtol: 0.0,
            growth_limit: 3.0,
            shrink_limit: 0.2,
        }
    }

    #[test]
    fn adaptive_controller_rejects_non_finite_and_stops_at_dt_min() {
        let cfg = test_config();
        assert_eq!(
            decide_adaptive_step(4, 1e-3, 4.0, None, cfg),
            AdaptiveDecision::Retry(2e-4)
        );
        assert_eq!(
            decide_adaptive_step(4, 1e-6, f64::NAN, None, cfg),
            AdaptiveDecision::NonFinite(crate::EngineErrorCode::NaNValue)
        );
        assert_eq!(
            decide_adaptive_step(4, 1e-6, f64::INFINITY, None, cfg),
            AdaptiveDecision::NonFinite(crate::EngineErrorCode::InfiniteValue)
        );
        assert_eq!(
            decide_adaptive_step(4, cfg.dt_min, 4.0, None, cfg),
            AdaptiveDecision::DtMinExhausted
        );
    }

    #[test]
    fn adaptive_controller_clamps_growth_and_shrinks_monotonically() {
        let cfg = test_config();
        assert_eq!(
            decide_adaptive_step(4, 9e-3, 0.0, None, cfg),
            AdaptiveDecision::Accepted(cfg.dt_max)
        );
        let AdaptiveDecision::Retry(next) = decide_adaptive_step(4, 1e-3, 4.0, None, cfg) else {
            panic!("finite rejection must retry");
        };
        assert!(next < 1e-3);
    }

    #[test]
    fn adaptive_controller_forces_a_representable_shrink_after_rounding() {
        let mut cfg = test_config();
        cfg.headroom = 1.0;
        let dt = 1e-3;
        let error = f64::from_bits(1.0f64.to_bits() + 1);
        let AdaptiveDecision::Retry(next) = decide_adaptive_step(4, dt, error, None, cfg) else {
            panic!("finite rejection must retry");
        };
        assert!(next < dt);
    }

    #[test]
    fn adaptive_controller_treats_one_ulp_above_dt_min_as_exhausted() {
        let cfg = test_config();
        let just_above_min = f64::from_bits(cfg.dt_min.to_bits() + 1);
        assert!(just_above_min > cfg.dt_min);
        assert_eq!(
            decide_adaptive_step(4, just_above_min, 4.0, None, cfg),
            AdaptiveDecision::DtMinExhausted
        );
    }

    #[test]
    fn adaptive_retry_budget_fails_with_a_bounded_terminal_record() {
        let mut problem = adaptive_test_problem(crate::TimeIntegrator::RK23);
        problem.dynamics.adaptive.dt_min = 1.0e-300;
        problem.dynamics.adaptive.headroom = 1.0;
        problem.dynamics.adaptive.shrink_limit = 0.99;
        let mut state = problem.uniform_state([1.0, 0.0, 0.0]).expect("state");
        let mut workspace = problem.create_workspace();
        let mut buffers = problem.create_integrator_buffers();
        buffers.set_adaptive_error_script_for_tests(std::iter::repeat_n(
            f64::from_bits(1.0f64.to_bits() + 1),
            51,
        ));

        let error = problem
            .rk23_step_buf(
                &mut state,
                1.0,
                &mut workspace,
                &mut buffers,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("retry budget must terminate");

        assert_eq!(error.to_string(), "adaptive_retry_limit_exhausted");
        assert_eq!(buffers.adaptive_attempts().len(), 51);
        assert_eq!(buffers.adaptive_rejected_attempts(), 50);
        assert_eq!(
            buffers
                .adaptive_attempts()
                .last()
                .expect("terminal attempt")
                .reason,
            crate::AdaptiveAttemptReason::RetryLimitExhausted
        );
    }

    fn adaptive_test_problem(integrator: crate::TimeIntegrator) -> crate::ExchangeLlgProblem {
        crate::ExchangeLlgProblem::with_terms(
            crate::GridShape::new(1, 1, 1).expect("valid grid"),
            crate::CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            crate::MaterialParameters::new(1.0, 1.0e-30, 0.1).expect("valid material"),
            crate::LlgConfig::new(100.0, integrator)
                .expect("valid LLG config")
                .with_adaptive(crate::AdaptiveStepConfig {
                    max_error: 1.0,
                    dt_min: 1.0e-9,
                    dt_max: 1.0,
                    headroom: 0.2,
                    rtol: 0.0,
                    growth_limit: 3.0,
                    shrink_limit: 0.2,
                }),
            crate::EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.0, 1.0, 0.0]),
                ..Default::default()
            },
        )
    }

    #[test]
    fn direct_cpu_entry_points_propagate_injected_nonfinite_error_norm() {
        for integrator in [crate::TimeIntegrator::RK23, crate::TimeIntegrator::RK45] {
            let problem = adaptive_test_problem(integrator);

            let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
            let aos_before = aos.clone();
            let mut aos_ws = problem.create_workspace();
            let mut aos_bufs = problem.create_integrator_buffers();
            aos_bufs.set_adaptive_error_script_for_tests([f64::NAN]);
            let error = match integrator {
                crate::TimeIntegrator::RK23 => problem.rk23_step_buf(
                    &mut aos,
                    1.0e-6,
                    &mut aos_ws,
                    &mut aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                crate::TimeIntegrator::RK45 => problem.rk45_step_buf(
                    &mut aos,
                    1.0e-6,
                    &mut aos_ws,
                    &mut aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                _ => unreachable!(),
            }
            .expect_err("AoS non-finite error norm must terminate");
            assert_eq!(error.to_string(), "non_finite_adaptive_error");
            assert_eq!(error.code(), crate::EngineErrorCode::NaNValue);
            assert_eq!(aos, aos_before);

            let mut soa_aos = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("SoA AoS state");
            let soa_aos_before = soa_aos.clone();
            let mut soa_aos_ws = problem.create_workspace();
            let mut soa_aos_bufs = problem.create_integrator_buffers();
            soa_aos_bufs.set_adaptive_error_script_for_tests([f64::INFINITY]);
            let error = match integrator {
                crate::TimeIntegrator::RK23 => problem.rk23_step_soa_buf(
                    &mut soa_aos,
                    1.0e-6,
                    &mut soa_aos_ws,
                    &mut soa_aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                crate::TimeIntegrator::RK45 => problem.rk45_step_soa_buf(
                    &mut soa_aos,
                    1.0e-6,
                    &mut soa_aos_ws,
                    &mut soa_aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                _ => unreachable!(),
            }
            .expect_err("SoA-buffer non-finite error norm must terminate");
            assert_eq!(error.to_string(), "non_finite_adaptive_error");
            assert_eq!(error.code(), crate::EngineErrorCode::InfiniteValue);
            assert_eq!(soa_aos, soa_aos_before);

            let mut persistent_soa = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("persistent SoA seed")
                .to_soa();
            let persistent_soa_before = persistent_soa.clone();
            let mut persistent_soa_ws = problem.create_workspace();
            let mut persistent_soa_bufs = problem.create_integrator_buffers();
            persistent_soa_bufs.set_adaptive_error_script_for_tests([f64::NAN]);
            let error = match integrator {
                crate::TimeIntegrator::RK23 => problem.rk23_step_soa_state_buf(
                    &mut persistent_soa,
                    1.0e-6,
                    &mut persistent_soa_ws,
                    &mut persistent_soa_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                crate::TimeIntegrator::RK45 => problem.rk45_step_soa_state_buf(
                    &mut persistent_soa,
                    1.0e-6,
                    &mut persistent_soa_ws,
                    &mut persistent_soa_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                _ => unreachable!(),
            }
            .expect_err("persistent-SoA non-finite error norm must terminate");
            assert_eq!(error.to_string(), "non_finite_adaptive_error");
            assert_eq!(error.code(), crate::EngineErrorCode::NaNValue);
            assert_eq!(persistent_soa, persistent_soa_before);
        }
    }

    #[test]
    fn direct_cpu_entry_points_record_injected_retry_dt() {
        for integrator in [crate::TimeIntegrator::RK23, crate::TimeIntegrator::RK45] {
            let problem = adaptive_test_problem(integrator);

            let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
            let mut aos_ws = problem.create_workspace();
            let mut aos_bufs = problem.create_integrator_buffers();
            aos_bufs.set_adaptive_error_script_for_tests([4.0, 0.0]);
            let report = match integrator {
                crate::TimeIntegrator::RK23 => problem.rk23_step_buf(
                    &mut aos,
                    1.0,
                    &mut aos_ws,
                    &mut aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                crate::TimeIntegrator::RK45 => problem.rk45_step_buf(
                    &mut aos,
                    1.0,
                    &mut aos_ws,
                    &mut aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                _ => unreachable!(),
            }
            .expect("AoS retry must accept the second attempt");
            assert_eq!(aos_bufs.adaptive_attempt_dts_for_tests(), &[1.0, 0.2]);
            assert_eq!(aos.time_seconds, report.dt_used);

            let mut soa_aos = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("SoA-buffer state");
            let mut soa_aos_ws = problem.create_workspace();
            let mut soa_aos_bufs = problem.create_integrator_buffers();
            soa_aos_bufs.set_adaptive_error_script_for_tests([4.0, 0.0]);
            let report = match integrator {
                crate::TimeIntegrator::RK23 => problem.rk23_step_soa_buf(
                    &mut soa_aos,
                    1.0,
                    &mut soa_aos_ws,
                    &mut soa_aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                crate::TimeIntegrator::RK45 => problem.rk45_step_soa_buf(
                    &mut soa_aos,
                    1.0,
                    &mut soa_aos_ws,
                    &mut soa_aos_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                _ => unreachable!(),
            }
            .expect("SoA-buffer retry must accept the second attempt");
            assert_eq!(soa_aos_bufs.adaptive_attempt_dts_for_tests(), &[1.0, 0.2]);
            assert_eq!(soa_aos.time_seconds, report.dt_used);

            let mut persistent_soa = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("persistent SoA seed")
                .to_soa();
            let mut persistent_soa_ws = problem.create_workspace();
            let mut persistent_soa_bufs = problem.create_integrator_buffers();
            persistent_soa_bufs.set_adaptive_error_script_for_tests([4.0, 0.0]);
            let report = match integrator {
                crate::TimeIntegrator::RK23 => problem.rk23_step_soa_state_buf(
                    &mut persistent_soa,
                    1.0,
                    &mut persistent_soa_ws,
                    &mut persistent_soa_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                crate::TimeIntegrator::RK45 => problem.rk45_step_soa_state_buf(
                    &mut persistent_soa,
                    1.0,
                    &mut persistent_soa_ws,
                    &mut persistent_soa_bufs,
                    crate::EvaluationRequest::Minimal,
                ),
                _ => unreachable!(),
            }
            .expect("persistent SoA retry must accept the second attempt");
            assert_eq!(
                persistent_soa_bufs.adaptive_attempt_dts_for_tests(),
                &[1.0, 0.2]
            );
            assert_eq!(persistent_soa.time_seconds, report.dt_used);
        }
    }

    #[test]
    fn adaptive_retry_reuses_thermal_counter_draw_and_scales_it_to_new_dt() {
        let mut retry_problem = adaptive_test_problem(crate::TimeIntegrator::RK23);
        retry_problem.temperature = 300.0;
        retry_problem.thermal_dt = 0.2;
        retry_problem.thermal_seed = 0x5eed;
        let mut retry_state = retry_problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("retry state");
        let mut retry_ws = retry_problem.create_workspace();
        let mut retry_bufs = retry_problem.create_integrator_buffers();
        retry_bufs.set_adaptive_error_script_for_tests([4.0, 0.0]);
        retry_problem
            .step_with_buffers_evaluation(
                &mut retry_state,
                1.0,
                &mut retry_ws,
                &mut retry_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("retrying thermal step");

        let mut clean_problem = adaptive_test_problem(crate::TimeIntegrator::RK23);
        clean_problem.temperature = 300.0;
        clean_problem.thermal_dt = 0.2;
        clean_problem.thermal_seed = 0x5eed;
        let mut clean_state = clean_problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("clean state");
        let mut clean_ws = clean_problem.create_workspace();
        let mut clean_bufs = clean_problem.create_integrator_buffers();
        clean_bufs.set_adaptive_error_script_for_tests([0.0]);
        clean_problem
            .step_with_buffers_evaluation(
                &mut clean_state,
                0.2,
                &mut clean_ws,
                &mut clean_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("clean thermal step");

        assert_eq!(retry_state, clean_state);
        assert_eq!(retry_problem.thermal_step(), 1);
        assert_eq!(clean_problem.thermal_step(), 1);
        assert_eq!(
            retry_problem
                .transactional_state_digest(&retry_state)
                .expect("retry digest"),
            clean_problem
                .transactional_state_digest(&clean_state)
                .expect("clean digest")
        );
    }

    #[test]
    fn failed_adaptive_attempt_preserves_transactional_digest_and_rng_interval() {
        let problem = adaptive_test_problem(crate::TimeIntegrator::RK45);
        let mut state = problem.uniform_state([1.0, 0.0, 0.0]).expect("state");
        let mut workspace = problem.create_workspace();
        let mut buffers = problem.create_integrator_buffers();
        buffers.set_adaptive_error_script_for_tests([0.0]);
        problem
            .step_with_buffers_evaluation(
                &mut state,
                1.0e-6,
                &mut workspace,
                &mut buffers,
                crate::EvaluationRequest::Minimal,
            )
            .expect("accepted FSAL seed step");
        let before = problem
            .transactional_state_digest(&state)
            .expect("state digest");
        let thermal_before = problem.thermal_step();
        buffers.set_adaptive_error_script_for_tests([f64::NAN]);
        let error = problem
            .step_with_buffers_evaluation(
                &mut state,
                1.0e-6,
                &mut workspace,
                &mut buffers,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("injected non-finite adaptive error");

        assert_eq!(error.code(), crate::EngineErrorCode::NaNValue);
        assert_eq!(
            problem
                .transactional_state_digest(&state)
                .expect("post-failure digest"),
            before
        );
        assert_eq!(problem.thermal_step(), thermal_before);
    }

    #[test]
    fn abm_failure_before_commit_preserves_magnetization_time_and_history_digest() {
        let problem = crate::ExchangeLlgProblem::with_terms(
            crate::GridShape::new(1, 1, 1).expect("grid"),
            crate::CellSize::new(1.0, 1.0, 1.0).expect("cell"),
            crate::MaterialParameters::new(1.0, 1.0e-30, 0.1).expect("material"),
            crate::LlgConfig::new(100.0, crate::TimeIntegrator::ABM3).expect("LLG"),
            crate::EffectiveFieldTerms {
                exchange: false,
                demag: false,
                ..Default::default()
            },
        );
        let dt = 1.0e-3;

        let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
        let mut aos_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        for _ in 0..3 {
            problem
                .abm3_step_buf(
                    &mut aos,
                    dt,
                    &mut aos_ws,
                    &mut aos_bufs,
                    crate::EvaluationRequest::Minimal,
                )
                .expect("ABM startup step");
        }
        aos.magnetization_mut()[0] = [f64::NAN; 3];
        let aos_before = problem
            .transactional_state_digest(&aos)
            .expect("AoS digest");
        let error = problem
            .abm3_step_buf(
                &mut aos,
                dt,
                &mut aos_ws,
                &mut aos_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("non-finite candidate must fail before commit");
        assert_eq!(error.code(), crate::EngineErrorCode::NaNValue);
        assert_eq!(
            problem
                .transactional_state_digest(&aos)
                .expect("AoS post-failure digest"),
            aos_before
        );

        let mut buffer_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("buffer SoA state");
        let mut buffer_soa_ws = problem.create_workspace();
        let mut buffer_soa_bufs = problem.create_integrator_buffers();
        for _ in 0..3 {
            problem
                .abm3_step_soa_buf(
                    &mut buffer_soa,
                    dt,
                    &mut buffer_soa_ws,
                    &mut buffer_soa_bufs,
                    crate::EvaluationRequest::Minimal,
                )
                .expect("SoA startup step");
        }
        buffer_soa.magnetization_mut()[0] = [f64::NAN; 3];
        let buffer_soa_before = buffer_soa.transactional_state_digest();
        let error = problem
            .abm3_step_soa_buf(
                &mut buffer_soa,
                dt,
                &mut buffer_soa_ws,
                &mut buffer_soa_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("non-finite SoA candidate must fail before commit");
        assert_eq!(error.code(), crate::EngineErrorCode::NaNValue);
        assert_eq!(buffer_soa.transactional_state_digest(), buffer_soa_before);

        let mut persistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("persistent SoA state")
            .to_soa();
        let mut persistent_ws = problem.create_workspace();
        let mut persistent_bufs = problem.create_integrator_buffers();
        for _ in 0..3 {
            problem
                .abm3_step_soa_state_buf(
                    &mut persistent_soa,
                    dt,
                    &mut persistent_ws,
                    &mut persistent_bufs,
                    crate::EvaluationRequest::Minimal,
                )
                .expect("persistent SoA startup step");
        }
        persistent_soa.magnetization.x[0] = f64::NAN;
        persistent_soa.magnetization.y[0] = f64::NAN;
        persistent_soa.magnetization.z[0] = f64::NAN;
        let persistent_before = persistent_soa.transactional_state_digest();
        let error = problem
            .abm3_step_soa_state_buf(
                &mut persistent_soa,
                dt,
                &mut persistent_ws,
                &mut persistent_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("persistent SoA non-finite candidate must fail before commit");
        assert_eq!(error.code(), crate::EngineErrorCode::NaNValue);
        assert_eq!(persistent_soa.transactional_state_digest(), persistent_before);
    }

    #[test]
    fn abm3_restarts_history_before_using_changed_dt() {
        let problem = crate::ExchangeLlgProblem::with_terms(
            crate::GridShape::new(1, 1, 1).expect("grid"),
            crate::CellSize::new(1.0, 1.0, 1.0).expect("cell"),
            crate::MaterialParameters::new(1.0, 1.0e-30, 0.1).expect("material"),
            crate::LlgConfig::new(100.0, crate::TimeIntegrator::ABM3).expect("LLG"),
            crate::EffectiveFieldTerms {
                exchange: false,
                demag: false,
                ..Default::default()
            },
        );
        let startup_dt = 1.0e-3;
        let changed_dt = 1.01e-3;

        let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
        let mut aos_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        for _ in 0..3 {
            problem
                .abm3_step_buf(
                    &mut aos,
                    startup_dt,
                    &mut aos_ws,
                    &mut aos_bufs,
                    crate::EvaluationRequest::Minimal,
                )
                .expect("AoS startup step");
        }
        assert!(aos.abm_history.is_ready());
        problem
            .abm3_step_buf(
                &mut aos,
                changed_dt,
                &mut aos_ws,
                &mut aos_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("AoS restart step");
        assert_eq!(aos.abm_history.startup_steps, 1);
        assert!(aos.abm_history.f_n_minus_1.is_none());
        assert_eq!(aos.abm_history.last_dt, changed_dt);

        let mut buffer_soa = problem.uniform_state([1.0, 0.0, 0.0]).expect("buffer SoA state");
        let mut buffer_soa_ws = problem.create_workspace();
        let mut buffer_soa_bufs = problem.create_integrator_buffers();
        for _ in 0..3 {
            problem
                .abm3_step_soa_buf(
                    &mut buffer_soa,
                    startup_dt,
                    &mut buffer_soa_ws,
                    &mut buffer_soa_bufs,
                    crate::EvaluationRequest::Minimal,
                )
                .expect("buffer SoA startup step");
        }
        assert!(buffer_soa.abm_history.is_ready());
        problem
            .abm3_step_soa_buf(
                &mut buffer_soa,
                changed_dt,
                &mut buffer_soa_ws,
                &mut buffer_soa_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("buffer SoA restart step");
        assert_eq!(buffer_soa.abm_history.startup_steps, 1);
        assert!(buffer_soa.abm_history.f_n_minus_1.is_none());
        assert_eq!(buffer_soa.abm_history.last_dt, changed_dt);

        let mut persistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("persistent SoA state")
            .to_soa();
        let mut persistent_soa_ws = problem.create_workspace();
        let mut persistent_soa_bufs = problem.create_integrator_buffers();
        for _ in 0..3 {
            problem
                .abm3_step_soa_state_buf(
                    &mut persistent_soa,
                    startup_dt,
                    &mut persistent_soa_ws,
                    &mut persistent_soa_bufs,
                    crate::EvaluationRequest::Minimal,
                )
                .expect("persistent SoA startup step");
        }
        assert!(persistent_soa.abm_history.is_ready());
        problem
            .abm3_step_soa_state_buf(
                &mut persistent_soa,
                changed_dt,
                &mut persistent_soa_ws,
                &mut persistent_soa_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("persistent SoA restart step");
        assert_eq!(persistent_soa.abm_history.startup_steps, 1);
        assert!(persistent_soa.abm_history.f_n_minus_1.is_none());
        assert_eq!(persistent_soa.abm_history.last_dt, changed_dt);
    }

    #[test]
    fn rk45_terminal_rejection_preserves_fsal_for_aos_and_persistent_soa() {
        let problem = adaptive_test_problem(crate::TimeIntegrator::RK45);

        let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
        let mut aos_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        problem
            .rk45_step_buf(
                &mut aos,
                1.0e-6,
                &mut aos_ws,
                &mut aos_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("accepted AoS RK45 step");
        assert_eq!(aos_bufs.adaptive_attempts()[0].rhs_evals, 7);
        assert!(aos.k_fsal.is_some());
        let aos_before = aos.clone();
        aos_bufs.set_adaptive_error_script_for_tests([f64::NAN]);
        let error = problem
            .rk45_step_buf(
                &mut aos,
                1.0e-6,
                &mut aos_ws,
                &mut aos_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("terminal AoS RK45 rejection");
        assert_eq!(error.to_string(), "non_finite_adaptive_error");
        assert_eq!(
            aos_bufs
                .adaptive_attempts()
                .last()
                .expect("terminal AoS attempt")
                .rhs_evals,
            6
        );
        assert_eq!(aos, aos_before);

        let mut buffer_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("buffer-SoA state");
        let mut buffer_soa_ws = problem.create_workspace();
        let mut buffer_soa_bufs = problem.create_integrator_buffers();
        problem
            .rk45_step_soa_buf(
                &mut buffer_soa,
                1.0e-6,
                &mut buffer_soa_ws,
                &mut buffer_soa_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("accepted buffer-SoA RK45 step");
        assert_eq!(buffer_soa_bufs.adaptive_attempts()[0].rhs_evals, 7);
        assert!(buffer_soa.k_fsal.is_some());
        let buffer_soa_before = buffer_soa.clone();
        buffer_soa_bufs.set_adaptive_error_script_for_tests([f64::NAN]);
        let error = problem
            .rk45_step_soa_buf(
                &mut buffer_soa,
                1.0e-6,
                &mut buffer_soa_ws,
                &mut buffer_soa_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("terminal buffer-SoA RK45 rejection");
        assert_eq!(error.to_string(), "non_finite_adaptive_error");
        assert_eq!(
            buffer_soa_bufs
                .adaptive_attempts()
                .last()
                .expect("terminal buffer-SoA attempt")
                .rhs_evals,
            6
        );
        assert_eq!(buffer_soa, buffer_soa_before);

        let mut persistent_soa = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("persistent SoA seed")
            .to_soa();
        let mut persistent_soa_ws = problem.create_workspace();
        let mut persistent_soa_bufs = problem.create_integrator_buffers();
        problem
            .rk45_step_soa_state_buf(
                &mut persistent_soa,
                1.0e-6,
                &mut persistent_soa_ws,
                &mut persistent_soa_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("accepted persistent-SoA RK45 step");
        assert_eq!(persistent_soa_bufs.adaptive_attempts()[0].rhs_evals, 7);
        assert!(persistent_soa.k_fsal.is_some());
        let persistent_soa_before = persistent_soa.clone();
        persistent_soa_bufs.set_adaptive_error_script_for_tests([f64::INFINITY]);
        let error = problem
            .rk45_step_soa_state_buf(
                &mut persistent_soa,
                1.0e-6,
                &mut persistent_soa_ws,
                &mut persistent_soa_bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect_err("terminal persistent-SoA RK45 rejection");
        assert_eq!(error.to_string(), "non_finite_adaptive_error");
        assert_eq!(
            persistent_soa_bufs
                .adaptive_attempts()
                .last()
                .expect("terminal persistent-SoA attempt")
                .rhs_evals,
            6
        );
        assert_eq!(persistent_soa, persistent_soa_before);
    }

    #[test]
    fn rk45_soa_buffer_reuses_aos_fsal_storage_after_warmup() {
        let problem = adaptive_test_problem(crate::TimeIntegrator::RK45);
        let mut state = problem.uniform_state([1.0, 0.0, 0.0]).expect("SoA-buffer state");
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();

        problem
            .rk45_step_soa_buf(
                &mut state,
                1.0e-6,
                &mut ws,
                &mut bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("first buffer-SoA RK45 step");
        let (fsal_ptr, fsal_capacity) = {
            let fsal = state.k_fsal.as_ref().expect("FSAL cache after first step");
            (fsal.as_ptr(), fsal.capacity())
        };

        problem
            .rk45_step_soa_buf(
                &mut state,
                1.0e-6,
                &mut ws,
                &mut bufs,
                crate::EvaluationRequest::Minimal,
            )
            .expect("second buffer-SoA RK45 step");
        let fsal = state.k_fsal.as_ref().expect("FSAL cache after second step");
        assert_eq!(fsal.as_ptr(), fsal_ptr);
        assert_eq!(fsal.capacity(), fsal_capacity);
    }

    #[test]
    fn cpu_controller_matches_task6_golden_vectors_and_zero_error_growth_limit() {
        let cfg = crate::AdaptiveStepConfig {
            max_error: 1.0,
            dt_min: 1e-16,
            dt_max: 1e-10,
            headroom: 0.9,
            rtol: 0.0,
            growth_limit: 3.0,
            shrink_limit: 0.2,
        };
        for (q, current, previous, expected) in [
            (2, 0.25, Some(0.5), 1.133928944905386),
            (4, 0.25, Some(0.5), 1.0338285194973316),
            (4, 0.9, Some(0.01), 0.6319002950076072),
        ] {
            let AdaptiveDecision::Accepted(next) =
                decide_adaptive_step(q, 1e-12, current, previous, cfg)
            else {
                panic!()
            };
            assert!((next / 1e-12 - expected).abs() <= 2e-15);
        }
        let AdaptiveDecision::Retry(next) = decide_adaptive_step(4, 1e-12, 4.0, None, cfg) else {
            panic!()
        };
        assert!((next / 1e-12 - 0.6820724549296792).abs() <= 2e-15);
        let AdaptiveDecision::Accepted(next) = decide_adaptive_step(4, 1e-15, 0.0, None, cfg)
        else {
            panic!()
        };
        assert!((next - 3e-15).abs() <= f64::EPSILON * 3e-15);
    }
}

impl ExchangeLlgProblem {
    /// Transactional explicit partition of canonical ARS(2,3,2). The coupled
    /// transport owner supplies stage-consistent implicit spin/charge terms;
    /// this method never substitutes Heun for the public coupled integrator.
    pub fn coupled_imex_ark2_fixed_step_with_external_stage_terms<F>(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
        mut external_terms: F,
    ) -> Result<StepReport>
    where
        F: FnMut(&[Vector3], f64, CoupledImexArk2Stage) -> Result<ExternalStageTerms>,
    {
        const GAMMA: f64 = CoupledImexArk2Tableau::GAMMA;
        const DELTA: f64 = CoupledImexArk2Tableau::DELTA;
        self.ensure_state_matches_grid(state)?;
        if dt <= 0.0 || !dt.is_finite() {
            return Err(crate::EngineError::with_code(
                crate::EngineErrorCode::InvalidTimestep,
                "dt must be finite and positive",
            ));
        }
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        self.effective_field_into_ws_at_time(&bufs.m0[..n], ws, &mut bufs.h_eff[..n], t0);
        let terms0 = external_terms(&bufs.m0[..n], t0, CoupledImexArk2Stage::ExplicitOrigin)?;
        apply_external_stage_terms(
            &bufs.m0[..n],
            &mut bufs.h_eff[..n],
            &mut bufs.k[0][..n],
            terms0,
            self.frozen_spins(),
            |m, h, rhs| self.llg_rhs_from_fields_with_direct_torques_into(m, h, rhs),
        )?;

        for i in 0..n {
            bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[0][i], GAMMA * dt)))?;
        }
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);
        self.effective_field_into_ws_at_time(
            &bufs.m_stage[..n],
            ws,
            &mut bufs.h_eff[..n],
            t0 + GAMMA * dt,
        );
        let terms1 = external_terms(
            &bufs.m_stage[..n],
            t0 + GAMMA * dt,
            CoupledImexArk2Stage::ImplicitStageOne,
        )?;
        apply_external_stage_terms(
            &bufs.m_stage[..n],
            &mut bufs.h_eff[..n],
            &mut bufs.k[1][..n],
            terms1,
            self.frozen_spins(),
            |m, h, rhs| self.llg_rhs_from_fields_with_direct_torques_into(m, h, rhs),
        )?;

        for i in 0..n {
            bufs.delta[i] = normalized(add(
                bufs.m0[i],
                scale(
                    add(scale(bufs.k[0][i], DELTA), scale(bufs.k[1][i], 1.0 - DELTA)),
                    dt,
                ),
            ))?;
        }
        self.restore_frozen_reference(&mut bufs.delta[..n]);
        self.effective_field_into_ws_at_time(&bufs.delta[..n], ws, &mut bufs.h_eff[..n], t0 + dt);
        let terms2 = external_terms(
            &bufs.delta[..n],
            t0 + dt,
            CoupledImexArk2Stage::ImplicitStageTwo,
        )?;
        apply_external_stage_terms(
            &bufs.delta[..n],
            &mut bufs.h_eff[..n],
            &mut bufs.k[2][..n],
            terms2,
            self.frozen_spins(),
            |m, h, rhs| self.llg_rhs_from_fields_with_direct_torques_into(m, h, rhs),
        )?;

        for i in 0..n {
            bufs.delta[i] = normalized(add(
                bufs.m0[i],
                scale(
                    add(scale(bufs.k[1][i], 1.0 - GAMMA), scale(bufs.k[2][i], GAMMA)),
                    dt,
                ),
            ))?;
        }
        self.restore_frozen_reference(&mut bufs.delta[..n]);
        let mut eval = self.compute_step_observables_at_time(
            &bufs.delta[..n],
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
            evaluation,
            t0 + dt,
        );
        let final_terms = external_terms(
            &bufs.delta[..n],
            t0 + dt,
            CoupledImexArk2Stage::AcceptedObservation,
        )?;
        let dynamic_field = final_terms.additional_field_apm.clone();
        let final_reductions = apply_external_stage_terms(
            &bufs.delta[..n],
            &mut bufs.h_eff[..n],
            &mut bufs.rhs[..n],
            final_terms,
            self.frozen_spins(),
            |m, h, rhs| self.llg_rhs_from_fields_with_direct_torques_into(m, h, rhs),
        )?;
        let dynamic_external_energy =
            self.external_energy_from_fields(&bufs.delta[..n], &dynamic_field);
        eval.external_energy_joules += dynamic_external_energy;
        eval.total_energy_joules += dynamic_external_energy;
        eval.max_effective_field_amplitude = bufs.h_eff[..n]
            .iter()
            .map(|value| norm(*value))
            .fold(0.0, f64::max);
        eval.max_rhs_amplitude = final_reductions.max_rhs_free_amplitude;
        eval.max_rhs_all_amplitude = final_reductions.max_rhs_all_amplitude;
        eval.max_torque_Apm = final_reductions.max_torque_free_apm;
        eval.max_torque_all_Apm = final_reductions.max_torque_all_apm;
        state.magnetization[..n].copy_from_slice(&bufs.delta[..n]);
        self.restore_frozen_reference(&mut state.magnetization[..n]);
        state.time_seconds = t0 + dt;
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    /// Commit side effects that must occur exactly once after the coupled
    /// owner accepts either a fixed trial or the adaptive two-half trial.
    pub fn commit_coupled_imex_ark2_step(&self) {
        self.advance_thermal_step();
    }

    /// Transactional Heun step for a solver coupled through stage-dependent
    /// fields and direct torques.
    ///
    /// The callback is evaluated at `(m_n, t_n)`, at the Heun predictor, and
    /// at the corrected candidate. The state is committed only after all
    /// three evaluations succeed, so a coupled-solver failure cannot leave a
    /// partially advanced magnetization or time.
    pub fn heun_step_with_external_stage_terms<F>(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
        mut external_terms: F,
    ) -> Result<StepReport>
    where
        F: FnMut(&[Vector3], f64) -> Result<ExternalStageTerms>,
    {
        self.heun_step_with_external_stage_terms_and_lte(
            state,
            dt,
            ws,
            bufs,
            evaluation,
            |magnetization, time_s, _| external_terms(magnetization, time_s),
        )
    }

    /// Transactional Heun step that exposes the Euler/Heun embedded magnetic
    /// LTE only while evaluating the corrected candidate. This is the point
    /// where a bidirectionally coupled transport solve can reject the whole
    /// step without committing either transport or magnetization.
    pub fn heun_step_with_external_stage_terms_and_lte<F>(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
        external_terms: F,
    ) -> Result<StepReport>
    where
        F: FnMut(
            &[Vector3],
            f64,
            Option<crate::fdm::TransportStageErrorBudget>,
        ) -> Result<ExternalStageTerms>,
    {
        let report = self.heun_trial_with_external_stage_terms_and_lte(
            state,
            dt,
            ws,
            bufs,
            evaluation,
            external_terms,
        )?;
        self.commit_heun_trial(state, bufs, dt);
        Ok(report)
    }

    /// Build a coupled Heun candidate without advancing the thermal interval.
    /// The coupled owner must commit its other authoritative state first and
    /// then call [`Self::commit_heun_trial`] exactly once.
    pub fn heun_trial_with_external_stage_terms_and_lte<F>(
        &self,
        state: &ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
        mut external_terms: F,
    ) -> Result<StepReport>
    where
        F: FnMut(
            &[Vector3],
            f64,
            Option<crate::fdm::TransportStageErrorBudget>,
        ) -> Result<ExternalStageTerms>,
    {
        self.ensure_state_matches_grid(state)?;
        if dt <= 0.0 || !dt.is_finite() {
            return Err(crate::EngineError::with_code(
                crate::EngineErrorCode::InvalidTimestep,
                "dt must be finite and positive",
            ));
        }
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        self.effective_field_into_ws_at_time(&bufs.m0[..n], ws, &mut bufs.h_eff[..n], t0);
        let terms0 = external_terms(&bufs.m0[..n], t0, None)?;
        apply_external_stage_terms(
            &bufs.m0[..n],
            &mut bufs.h_eff[..n],
            &mut bufs.k[0][..n],
            terms0,
            self.frozen_spins(),
            |m, h, rhs| self.llg_rhs_from_fields_with_direct_torques_into(m, h, rhs),
        )?;

        for i in 0..n {
            bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[0][i], dt)))?;
        }
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);

        self.effective_field_into_ws_at_time(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n], t0 + dt);
        let terms1 = external_terms(&bufs.m_stage[..n], t0 + dt, None)?;
        apply_external_stage_terms(
            &bufs.m_stage[..n],
            &mut bufs.h_eff[..n],
            &mut bufs.k[1][..n],
            terms1,
            self.frozen_spins(),
            |m, h, rhs| self.llg_rhs_from_fields_with_direct_torques_into(m, h, rhs),
        )?;

        // `delta` owns the corrected candidate until the coupled solve and
        // final observables have both succeeded.
        for i in 0..n {
            bufs.delta[i] = normalized(add(
                bufs.m0[i],
                scale(add(bufs.k[0][i], bufs.k[1][i]), 0.5 * dt),
            ))?;
        }
        self.restore_frozen_reference(&mut bufs.delta[..n]);

        let mut eval = self.compute_step_observables_at_time(
            &bufs.delta[..n],
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
            evaluation,
            t0 + dt,
        );
        let embedded_lte_m = bufs.delta[..n]
            .iter()
            .zip(&bufs.m_stage[..n])
            .map(|(corrected, predictor)| {
                let difference = [
                    corrected[0] - predictor[0],
                    corrected[1] - predictor[1],
                    corrected[2] - predictor[2],
                ];
                let value = norm(difference);
                value * value
            })
            .sum::<f64>();
        let embedded_lte_m = (embedded_lte_m / n.max(1) as f64).sqrt();
        let final_terms = external_terms(
            &bufs.delta[..n],
            t0 + dt,
            Some(crate::fdm::TransportStageErrorBudget {
                dt_s: dt,
                embedded_lte_m,
            }),
        )?;
        let dynamic_field = final_terms.additional_field_apm.clone();
        let final_reductions = apply_external_stage_terms(
            &bufs.delta[..n],
            &mut bufs.h_eff[..n],
            &mut bufs.rhs[..n],
            final_terms,
            self.frozen_spins(),
            |m, h, rhs| self.llg_rhs_from_fields_with_direct_torques_into(m, h, rhs),
        )?;

        let dynamic_external_energy =
            self.external_energy_from_fields(&bufs.delta[..n], &dynamic_field);
        eval.external_energy_joules += dynamic_external_energy;
        eval.total_energy_joules += dynamic_external_energy;
        eval.max_effective_field_amplitude = bufs.h_eff[..n]
            .iter()
            .map(|value| norm(*value))
            .fold(0.0, f64::max);
        eval.max_rhs_amplitude = final_reductions.max_rhs_free_amplitude;
        eval.max_rhs_all_amplitude = final_reductions.max_rhs_all_amplitude;
        eval.max_torque_Apm = final_reductions.max_torque_free_apm;
        eval.max_torque_all_Apm = final_reductions.max_torque_all_apm;

        Ok(eval.into_step_report(t0 + dt, dt, false))
    }

    /// Commit the candidate left by
    /// [`Self::heun_trial_with_external_stage_terms_and_lte`].
    pub fn commit_heun_trial(
        &self,
        state: &mut ExchangeLlgState,
        bufs: &IntegratorBuffers,
        dt: f64,
    ) {
        let n = state.magnetization.len();
        state.magnetization[..n].copy_from_slice(&bufs.delta[..n]);
        self.restore_frozen_reference(&mut state.magnetization[..n]);
        state.time_seconds += dt;
        self.advance_thermal_step();
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing Heun step (zero-allocation hot path)
    // -----------------------------------------------------------------------
    pub(crate) fn heun_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // k1 = f(t, m0)
        self.effective_field_into_ws_at_time(&bufs.m0[..n], ws, &mut bufs.h_eff[..n], t0);
        self.llg_rhs_from_fields_with_direct_torques_into(
            &bufs.m0[..n],
            &bufs.h_eff[..n],
            &mut bufs.k[0][..n],
        );

        // predicted = normalize(m0 + dt * k1)
        {
            let (stage, m0, k0) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(k0.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(k0[i], dt)))?;
            }
        }

        // k2 = f(t+dt, predicted)
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);
        self.effective_field_into_ws_at_time(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n], t0 + dt);
        self.llg_rhs_from_fields_with_direct_torques_into(
            &bufs.m_stage[..n],
            &bufs.h_eff[..n],
            &mut bufs.k[1][..n],
        );

        // corrected = normalize(m0 + dt/2 * (k1 + k2))
        {
            let (mag, m0, k0, k1) = (
                &mut state.magnetization[..n],
                &bufs.m0[..n],
                &bufs.k[0][..n],
                &bufs.k[1][..n],
            );
            #[cfg(feature = "parallel")]
            mag.par_iter_mut()
                .zip(m0.par_iter())
                .zip(k0.par_iter())
                .zip(k1.par_iter())
                .try_for_each(|(((m, m0), k0), k1)| -> Result<()> {
                    *m = normalized(add(*m0, scale(add(*k0, *k1), 0.5 * dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                mag[i] = normalized(add(m0[i], scale(add(k0[i], k1[i]), 0.5 * dt)))?;
            }
        }
        self.restore_frozen_reference(&mut state.magnetization[..n]);
        state.time_seconds += dt;

        let eval = self.compute_step_observables_at_time(
            &state.magnetization,
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
            evaluation,
            state.time_seconds,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    pub(crate) fn heun_step_soa_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.soa.m0.scatter_from_aos(&state.magnetization);

        self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
        self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);

        for i in 0..n {
            let predicted = normalized([
                bufs.soa.m0.x[i] + dt * bufs.soa.k[0].x[i],
                bufs.soa.m0.y[i] + dt * bufs.soa.k[0].y[i],
                bufs.soa.m0.z[i] + dt * bufs.soa.k[0].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = predicted[0];
            bufs.soa.m_stage.y[i] = predicted[1];
            bufs.soa.m_stage.z[i] = predicted[2];
        }

        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);

        for i in 0..n {
            state.magnetization[i] = normalized([
                bufs.soa.m0.x[i] + 0.5 * dt * (bufs.soa.k[0].x[i] + bufs.soa.k[1].x[i]),
                bufs.soa.m0.y[i] + 0.5 * dt * (bufs.soa.k[0].y[i] + bufs.soa.k[1].y[i]),
                bufs.soa.m0.z[i] + 0.5 * dt * (bufs.soa.k[0].z[i] + bufs.soa.k[1].z[i]),
            ])?;
        }
        state.time_seconds += dt;

        let eval = self.compute_step_observables_at_time(
            &state.magnetization,
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
            evaluation,
            state.time_seconds,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK4 step (zero-allocation hot path)
    // -----------------------------------------------------------------------
    pub(crate) fn rk4_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // k1 = f(t, m0)
        self.effective_field_into_ws_at_time(&bufs.m0[..n], ws, &mut bufs.h_eff[..n], t0);
        self.llg_rhs_from_fields_with_direct_torques_into(
            &bufs.m0[..n],
            &bufs.h_eff[..n],
            &mut bufs.k[0][..n],
        );

        // m1 = normalize(m0 + dt/2 * k1)
        {
            let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(kj.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, 0.5 * dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(kj[i], 0.5 * dt)))?;
            }
        }
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);
        self.effective_field_into_ws_at_time(
            &bufs.m_stage[..n],
            ws,
            &mut bufs.h_eff[..n],
            t0 + 0.5 * dt,
        );
        self.llg_rhs_from_fields_with_direct_torques_into(
            &bufs.m_stage[..n],
            &bufs.h_eff[..n],
            &mut bufs.k[1][..n],
        );

        // m2 = normalize(m0 + dt/2 * k2)
        {
            let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[1][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(kj.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, 0.5 * dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(kj[i], 0.5 * dt)))?;
            }
        }
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);
        self.effective_field_into_ws_at_time(
            &bufs.m_stage[..n],
            ws,
            &mut bufs.h_eff[..n],
            t0 + 0.5 * dt,
        );
        self.llg_rhs_from_fields_with_direct_torques_into(
            &bufs.m_stage[..n],
            &bufs.h_eff[..n],
            &mut bufs.k[2][..n],
        );

        // m3 = normalize(m0 + dt * k3)
        {
            let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[2][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(kj.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(kj[i], dt)))?;
            }
        }
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);
        self.effective_field_into_ws_at_time(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n], t0 + dt);
        self.llg_rhs_from_fields_with_direct_torques_into(
            &bufs.m_stage[..n],
            &bufs.h_eff[..n],
            &mut bufs.k[3][..n],
        );

        // y = normalize(m0 + dt/6 * (k1 + 2*k2 + 2*k3 + k4))
        {
            let (mag, m0) = (&mut state.magnetization[..n], &bufs.m0[..n]);
            let (k0, k1, k2, k3) = (
                &bufs.k[0][..n],
                &bufs.k[1][..n],
                &bufs.k[2][..n],
                &bufs.k[3][..n],
            );
            let dt6 = dt / 6.0;
            #[cfg(feature = "parallel")]
            mag.par_iter_mut()
                .enumerate()
                .try_for_each(|(i, m)| -> Result<()> {
                    *m = normalized(add(
                        m0[i],
                        scale(
                            add(add(k0[i], scale(k1[i], 2.0)), add(scale(k2[i], 2.0), k3[i])),
                            dt6,
                        ),
                    ))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                mag[i] = normalized(add(
                    m0[i],
                    scale(
                        add(add(k0[i], scale(k1[i], 2.0)), add(scale(k2[i], 2.0), k3[i])),
                        dt6,
                    ),
                ))?;
            }
        }
        self.restore_frozen_reference(&mut state.magnetization[..n]);
        state.time_seconds += dt;

        let eval = self.compute_step_observables_at_time(
            &state.magnetization,
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
            evaluation,
            state.time_seconds,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    pub(crate) fn rk4_step_soa_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.soa.m0.scatter_from_aos(&state.magnetization);

        self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
        self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);

        for i in 0..n {
            let stage = normalized([
                bufs.soa.m0.x[i] + 0.5 * dt * bufs.soa.k[0].x[i],
                bufs.soa.m0.y[i] + 0.5 * dt * bufs.soa.k[0].y[i],
                bufs.soa.m0.z[i] + 0.5 * dt * bufs.soa.k[0].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }
        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + 0.5 * dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);

        for i in 0..n {
            let stage = normalized([
                bufs.soa.m0.x[i] + 0.5 * dt * bufs.soa.k[1].x[i],
                bufs.soa.m0.y[i] + 0.5 * dt * bufs.soa.k[1].y[i],
                bufs.soa.m0.z[i] + 0.5 * dt * bufs.soa.k[1].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }
        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + 0.5 * dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[2]);

        for i in 0..n {
            let stage = normalized([
                bufs.soa.m0.x[i] + dt * bufs.soa.k[2].x[i],
                bufs.soa.m0.y[i] + dt * bufs.soa.k[2].y[i],
                bufs.soa.m0.z[i] + dt * bufs.soa.k[2].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }
        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[3]);

        let dt6 = dt / 6.0;
        for i in 0..n {
            let weighted_x = (bufs.soa.k[0].x[i] + 2.0 * bufs.soa.k[1].x[i])
                + (2.0 * bufs.soa.k[2].x[i] + bufs.soa.k[3].x[i]);
            let weighted_y = (bufs.soa.k[0].y[i] + 2.0 * bufs.soa.k[1].y[i])
                + (2.0 * bufs.soa.k[2].y[i] + bufs.soa.k[3].y[i]);
            let weighted_z = (bufs.soa.k[0].z[i] + 2.0 * bufs.soa.k[1].z[i])
                + (2.0 * bufs.soa.k[2].z[i] + bufs.soa.k[3].z[i]);
            state.magnetization[i] = normalized([
                bufs.soa.m0.x[i] + dt6 * weighted_x,
                bufs.soa.m0.y[i] + dt6 * weighted_y,
                bufs.soa.m0.z[i] + dt6 * weighted_z,
            ])?;
        }
        state.time_seconds += dt;

        let eval = self.compute_step_observables_at_time(
            &state.magnetization,
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
            evaluation,
            state.time_seconds,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // In-place RHS helpers
    // -----------------------------------------------------------------------
    #[allow(dead_code)]
    pub(crate) fn llg_rhs_into_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        out: &mut [Vector3],
    ) {
        let rhs = self.llg_rhs_from_vectors_ws(magnetization, ws);
        out[..rhs.len()].copy_from_slice(&rhs);
    }

    pub(crate) fn _llg_rhs_full_into_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        h_scratch: &mut [Vector3],
        out: &mut [Vector3],
    ) -> crate::RhsEvaluation {
        self.compute_step_observables_zero_alloc(magnetization, ws, h_eff, h_scratch, out)
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK23 (Bogacki-Shampine 2(3), adaptive)
    // -----------------------------------------------------------------------
    pub(crate) fn rk23_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut adaptive_controller =
            AdaptiveStepController::new(2, cfg, state.adaptive_previous_error);
        let mut dt = if self.dynamics.adaptive_enabled {
            dt.min(cfg.dt_max).max(cfg.dt_min)
        } else {
            dt
        };
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        loop {
            self.set_thermal_dt_for_attempt(dt);
            let mut rhs_evals = AttemptRhsCounter::default();
            // k1 = f(t, m0)
            self.effective_field_into_ws_at_time(&bufs.m0[..n], ws, &mut bufs.h_eff[..n], t0);
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m0[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[0][..n],
            );
            rhs_evals.record();

            // m1 = normalize(m0 + dt/2 * k1)
            {
                let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
                let f = 0.5 * dt;
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(kj.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, f)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(kj[i], f)))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + 0.5 * dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[1][..n],
            );
            rhs_evals.record();

            // m2 = normalize(m0 + 3dt/4 * k2)
            {
                let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[1][..n]);
                let f = 0.75 * dt;
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(kj.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, f)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(kj[i], f)))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + 0.75 * dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[2][..n],
            );
            rhs_evals.record();

            // y3 = normalize(m0 + dt*(2/9*k1 + 1/3*k2 + 4/9*k3))
            {
                let (delta, stage, m0) =
                    (&mut bufs.delta[..n], &mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2) = (&bufs.k[0][..n], &bufs.k[1][..n], &bufs.k[2][..n]);
                #[cfg(feature = "parallel")]
                delta
                    .par_iter_mut()
                    .zip(stage.par_iter_mut())
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, ((d, s), m))| -> Result<()> {
                        *d = scale(
                            add(
                                add(scale(k0[i], 2.0 / 9.0), scale(k1[i], 1.0 / 3.0)),
                                scale(k2[i], 4.0 / 9.0),
                            ),
                            dt,
                        );
                        *s = normalized(add(*m, *d))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    delta[i] = scale(
                        add(
                            add(scale(k0[i], 2.0 / 9.0), scale(k1[i], 1.0 / 3.0)),
                            scale(k2[i], 4.0 / 9.0),
                        ),
                        dt,
                    );
                    stage[i] = normalized(add(m0[i], delta[i]))?;
                }
            }

            // k4 for error estimate
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[3][..n],
            );
            rhs_evals.record();

            // Error
            let error = self.max_error_norm_buf(
                &[
                    (0, -5.0 / 72.0),
                    (1, 1.0 / 12.0),
                    (2, 1.0 / 9.0),
                    (3, -1.0 / 8.0),
                ],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };
            let normalized_error = error / thr;
            let decision = if self.dynamics.adaptive_enabled {
                decide_adaptive_attempt(
                    dt,
                    normalized_error,
                    rhs_evals.finish(),
                    bufs,
                    &mut adaptive_controller,
                )
            } else {
                AdaptiveDecision::Accepted(dt)
            };

            if let AdaptiveDecision::Accepted(dt_next) = decision {
                state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
                self.restore_frozen_reference(&mut state.magnetization[..n]);
                state.time_seconds += dt;
                let eval = self.compute_step_observables_at_time(
                    &state.magnetization,
                    ws,
                    &mut bufs.h_eff,
                    &mut bufs.h_scratch,
                    &mut bufs.rhs,
                    evaluation,
                    state.time_seconds,
                );
                state.adaptive_previous_error = if self.dynamics.adaptive_enabled {
                    adaptive_controller.previous_error()
                } else {
                    None
                };
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = self.dynamics.adaptive_enabled.then_some(dt_next);
                return Ok(report);
            }
            match decision {
                AdaptiveDecision::Retry(next) => dt = next,
                AdaptiveDecision::DtMinExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveDtMinExhausted,
                        "dt_min_exhausted",
                    ));
                }
                AdaptiveDecision::NonFinite(code) => {
                    return Err(crate::EngineError::with_code(
                        code,
                        "non_finite_adaptive_error",
                    ));
                }
                AdaptiveDecision::RetryLimitExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveRetryLimitExhausted,
                        "adaptive_retry_limit_exhausted",
                    ));
                }
                AdaptiveDecision::Accepted(_) => unreachable!("accepted decision returned above"),
            }
        }
    }

    pub(crate) fn rk23_step_soa_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut adaptive_controller =
            AdaptiveStepController::new(2, cfg, state.adaptive_previous_error);
        let mut dt = if self.dynamics.adaptive_enabled {
            dt.min(cfg.dt_max).max(cfg.dt_min)
        } else {
            dt
        };
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.soa.m0.scatter_from_aos(&state.magnetization);

        loop {
            self.set_thermal_dt_for_attempt(dt);
            let mut rhs_evals = AttemptRhsCounter::default();
            self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
            self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + 0.5 * dt * bufs.soa.k[0].x[i],
                    bufs.soa.m0.y[i] + 0.5 * dt * bufs.soa.k[0].y[i],
                    bufs.soa.m0.z[i] + 0.5 * dt * bufs.soa.k[0].z[i],
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + 0.5 * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + 0.75 * dt * bufs.soa.k[1].x[i],
                    bufs.soa.m0.y[i] + 0.75 * dt * bufs.soa.k[1].y[i],
                    bufs.soa.m0.z[i] + 0.75 * dt * bufs.soa.k[1].z[i],
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + 0.75 * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[2]);
            rhs_evals.record();

            for i in 0..n {
                let weighted_x = (2.0 / 9.0) * bufs.soa.k[0].x[i]
                    + (1.0 / 3.0) * bufs.soa.k[1].x[i]
                    + (4.0 / 9.0) * bufs.soa.k[2].x[i];
                let weighted_y = (2.0 / 9.0) * bufs.soa.k[0].y[i]
                    + (1.0 / 3.0) * bufs.soa.k[1].y[i]
                    + (4.0 / 9.0) * bufs.soa.k[2].y[i];
                let weighted_z = (2.0 / 9.0) * bufs.soa.k[0].z[i]
                    + (1.0 / 3.0) * bufs.soa.k[1].z[i]
                    + (4.0 / 9.0) * bufs.soa.k[2].z[i];
                let stage = normalized([
                    bufs.soa.m0.x[i] + dt * weighted_x,
                    bufs.soa.m0.y[i] + dt * weighted_y,
                    bufs.soa.m0.z[i] + dt * weighted_z,
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }

            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[3]);
            rhs_evals.record();

            let error = self.max_error_norm_soa_buf(
                &[
                    (0, -5.0 / 72.0),
                    (1, 1.0 / 12.0),
                    (2, 1.0 / 9.0),
                    (3, -1.0 / 8.0),
                ],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };
            let normalized_error = error / thr;
            let decision = if self.dynamics.adaptive_enabled {
                decide_adaptive_attempt(
                    dt,
                    normalized_error,
                    rhs_evals.finish(),
                    bufs,
                    &mut adaptive_controller,
                )
            } else {
                AdaptiveDecision::Accepted(dt)
            };

            if let AdaptiveDecision::Accepted(dt_next) = decision {
                bufs.soa
                    .m_stage
                    .gather_into_aos(&mut state.magnetization[..n]);
                state.time_seconds += dt;
                let eval = self.compute_step_observables_at_time(
                    &state.magnetization,
                    ws,
                    &mut bufs.h_eff,
                    &mut bufs.h_scratch,
                    &mut bufs.rhs,
                    evaluation,
                    state.time_seconds,
                );
                state.adaptive_previous_error = if self.dynamics.adaptive_enabled {
                    adaptive_controller.previous_error()
                } else {
                    None
                };
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = self.dynamics.adaptive_enabled.then_some(dt_next);
                return Ok(report);
            }
            match decision {
                AdaptiveDecision::Retry(next) => dt = next,
                AdaptiveDecision::DtMinExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveDtMinExhausted,
                        "dt_min_exhausted",
                    ));
                }
                AdaptiveDecision::NonFinite(code) => {
                    return Err(crate::EngineError::with_code(
                        code,
                        "non_finite_adaptive_error",
                    ));
                }
                AdaptiveDecision::RetryLimitExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveRetryLimitExhausted,
                        "adaptive_retry_limit_exhausted",
                    ));
                }
                AdaptiveDecision::Accepted(_) => unreachable!("accepted decision returned above"),
            }
        }
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK45 (Dormand-Prince 4(5), adaptive)
    // -----------------------------------------------------------------------
    pub(crate) fn rk45_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut adaptive_controller =
            AdaptiveStepController::new(4, cfg, state.adaptive_previous_error);
        let mut dt = if self.dynamics.adaptive_enabled {
            dt.min(cfg.dt_max).max(cfg.dt_min)
        } else {
            dt
        };
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        let dynamic_oersted = self
            .terms
            .oersted_cylinder
            .as_ref()
            .is_some_and(|cfg| cfg.time_dep_kind != 0);
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // Dormand-Prince coefficients
        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            self.set_thermal_dt_for_attempt(dt);
            let mut rhs_evals = AttemptRhsCounter::default();
            // Stage 1 — FSAL: reuse k7 from previous accepted step
            let reusable_fsal = (!dynamic_oersted).then(|| state.k_fsal.as_ref()).flatten();
            if let Some(fsal) = reusable_fsal {
                bufs.k[0][..n].copy_from_slice(&fsal);
            } else {
                self.effective_field_into_ws_at_time(&bufs.m0[..n], ws, &mut bufs.h_eff[..n], t0);
                self.llg_rhs_from_fields_with_direct_torques_into(
                    &bufs.m0[..n],
                    &bufs.h_eff[..n],
                    &mut bufs.k[0][..n],
                );
                rhs_evals.record();
            }

            // Stage 2
            {
                let (stage, m0, k0) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
                let f = A21 * dt;
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(k0.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, f)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(k0[i], f)))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + (1.0 / 5.0) * dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[1][..n],
            );
            rhs_evals.record();

            // Stage 3
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1) = (&bufs.k[0][..n], &bufs.k[1][..n]);
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(add(scale(k0[i], A31), scale(k1[i], A32)), dt),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(add(scale(k0[i], A31), scale(k1[i], A32)), dt),
                    ))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + (3.0 / 10.0) * dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[2][..n],
            );
            rhs_evals.record();

            // Stage 4
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2) = (&bufs.k[0][..n], &bufs.k[1][..n], &bufs.k[2][..n]);
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(add(scale(k0[i], A41), scale(k1[i], A42)), scale(k2[i], A43)),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(add(scale(k0[i], A41), scale(k1[i], A42)), scale(k2[i], A43)),
                            dt,
                        ),
                    ))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + (4.0 / 5.0) * dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[3][..n],
            );
            rhs_evals.record();

            // Stage 5
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2, k3) = (
                    &bufs.k[0][..n],
                    &bufs.k[1][..n],
                    &bufs.k[2][..n],
                    &bufs.k[3][..n],
                );
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(
                                    add(scale(k0[i], A51), scale(k1[i], A52)),
                                    add(scale(k2[i], A53), scale(k3[i], A54)),
                                ),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(
                                add(scale(k0[i], A51), scale(k1[i], A52)),
                                add(scale(k2[i], A53), scale(k3[i], A54)),
                            ),
                            dt,
                        ),
                    ))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + (8.0 / 9.0) * dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[4][..n],
            );
            rhs_evals.record();

            // Stage 6
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2, k3, k4) = (
                    &bufs.k[0][..n],
                    &bufs.k[1][..n],
                    &bufs.k[2][..n],
                    &bufs.k[3][..n],
                    &bufs.k[4][..n],
                );
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(
                                    add(
                                        add(scale(k0[i], A61), scale(k1[i], A62)),
                                        scale(k2[i], A63),
                                    ),
                                    add(scale(k3[i], A64), scale(k4[i], A65)),
                                ),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(
                                add(add(scale(k0[i], A61), scale(k1[i], A62)), scale(k2[i], A63)),
                                add(scale(k3[i], A64), scale(k4[i], A65)),
                            ),
                            dt,
                        ),
                    ))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[5][..n],
            );
            rhs_evals.record();

            // 5th-order solution → m_stage
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k2, k3, k4, k5) = (
                    &bufs.k[0][..n],
                    &bufs.k[2][..n],
                    &bufs.k[3][..n],
                    &bufs.k[4][..n],
                    &bufs.k[5][..n],
                );
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(
                                    add(add(scale(k0[i], B1), scale(k2[i], B3)), scale(k3[i], B4)),
                                    add(scale(k4[i], B5), scale(k5[i], B6)),
                                ),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(
                                add(add(scale(k0[i], B1), scale(k2[i], B3)), scale(k3[i], B4)),
                                add(scale(k4[i], B5), scale(k5[i], B6)),
                            ),
                            dt,
                        ),
                    ))?;
                }
            }

            // k7 for error estimate (FSAL) → k[6]
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[6][..n],
            );
            rhs_evals.record();

            // Error estimate
            let error = self.max_error_norm_buf(
                &[(0, E1), (2, E3), (3, E4), (4, E5), (5, E6), (6, E7)],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };
            let normalized_error = error / thr;
            let decision = if self.dynamics.adaptive_enabled {
                decide_adaptive_attempt(
                    dt,
                    normalized_error,
                    rhs_evals.finish(),
                    bufs,
                    &mut adaptive_controller,
                )
            } else {
                AdaptiveDecision::Accepted(dt)
            };

            if let AdaptiveDecision::Accepted(dt_next) = decision {
                state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
                self.restore_frozen_reference(&mut state.magnetization[..n]);
                state.time_seconds += dt;
                if dynamic_oersted {
                    state.k_fsal = None;
                } else if let Some(fsal) = &mut state.k_fsal {
                    fsal.copy_from_slice(&bufs.k[6][..n]);
                } else {
                    state.k_fsal = Some(bufs.k[6][..n].to_vec());
                }
                let eval = self.compute_step_observables_at_time(
                    &state.magnetization,
                    ws,
                    &mut bufs.h_eff,
                    &mut bufs.h_scratch,
                    &mut bufs.rhs,
                    evaluation,
                    state.time_seconds,
                );
                state.adaptive_previous_error = if self.dynamics.adaptive_enabled {
                    adaptive_controller.previous_error()
                } else {
                    None
                };
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = self.dynamics.adaptive_enabled.then_some(dt_next);
                return Ok(report);
            }
            match decision {
                AdaptiveDecision::Retry(next) => dt = next,
                AdaptiveDecision::DtMinExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveDtMinExhausted,
                        "dt_min_exhausted",
                    ));
                }
                AdaptiveDecision::NonFinite(code) => {
                    return Err(crate::EngineError::with_code(
                        code,
                        "non_finite_adaptive_error",
                    ));
                }
                AdaptiveDecision::RetryLimitExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveRetryLimitExhausted,
                        "adaptive_retry_limit_exhausted",
                    ));
                }
                AdaptiveDecision::Accepted(_) => unreachable!("accepted decision returned above"),
            }
        }
    }

    pub(crate) fn rk45_step_soa_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut adaptive_controller =
            AdaptiveStepController::new(4, cfg, state.adaptive_previous_error);
        let mut dt = if self.dynamics.adaptive_enabled {
            dt.min(cfg.dt_max).max(cfg.dt_min)
        } else {
            dt
        };
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        let dynamic_oersted = self
            .terms
            .oersted_cylinder
            .as_ref()
            .is_some_and(|cfg| cfg.time_dep_kind != 0);
        bufs.soa.m0.scatter_from_aos(&state.magnetization);

        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            self.set_thermal_dt_for_attempt(dt);
            let mut rhs_evals = AttemptRhsCounter::default();
            let reusable_fsal = (!dynamic_oersted).then(|| state.k_fsal.as_ref()).flatten();
            if let Some(fsal) = reusable_fsal {
                bufs.soa.k[0].scatter_from_aos(&fsal);
            } else {
                self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
                self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);
                rhs_evals.record();
            }

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + dt * A21 * bufs.soa.k[0].x[i],
                    bufs.soa.m0.y[i] + dt * A21 * bufs.soa.k[0].y[i],
                    bufs.soa.m0.z[i] + dt * A21 * bufs.soa.k[0].z[i],
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (1.0 / 5.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + dt * (A31 * bufs.soa.k[0].x[i] + A32 * bufs.soa.k[1].x[i]),
                    bufs.soa.m0.y[i] + dt * (A31 * bufs.soa.k[0].y[i] + A32 * bufs.soa.k[1].y[i]),
                    bufs.soa.m0.z[i] + dt * (A31 * bufs.soa.k[0].z[i] + A32 * bufs.soa.k[1].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (3.0 / 10.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[2]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (A41 * bufs.soa.k[0].x[i]
                            + A42 * bufs.soa.k[1].x[i]
                            + A43 * bufs.soa.k[2].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (A41 * bufs.soa.k[0].y[i]
                            + A42 * bufs.soa.k[1].y[i]
                            + A43 * bufs.soa.k[2].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (A41 * bufs.soa.k[0].z[i]
                            + A42 * bufs.soa.k[1].z[i]
                            + A43 * bufs.soa.k[2].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (4.0 / 5.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[3]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (A51 * bufs.soa.k[0].x[i]
                            + A52 * bufs.soa.k[1].x[i]
                            + A53 * bufs.soa.k[2].x[i]
                            + A54 * bufs.soa.k[3].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (A51 * bufs.soa.k[0].y[i]
                            + A52 * bufs.soa.k[1].y[i]
                            + A53 * bufs.soa.k[2].y[i]
                            + A54 * bufs.soa.k[3].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (A51 * bufs.soa.k[0].z[i]
                            + A52 * bufs.soa.k[1].z[i]
                            + A53 * bufs.soa.k[2].z[i]
                            + A54 * bufs.soa.k[3].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (8.0 / 9.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[4]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (A61 * bufs.soa.k[0].x[i]
                            + A62 * bufs.soa.k[1].x[i]
                            + A63 * bufs.soa.k[2].x[i]
                            + A64 * bufs.soa.k[3].x[i]
                            + A65 * bufs.soa.k[4].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (A61 * bufs.soa.k[0].y[i]
                            + A62 * bufs.soa.k[1].y[i]
                            + A63 * bufs.soa.k[2].y[i]
                            + A64 * bufs.soa.k[3].y[i]
                            + A65 * bufs.soa.k[4].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (A61 * bufs.soa.k[0].z[i]
                            + A62 * bufs.soa.k[1].z[i]
                            + A63 * bufs.soa.k[2].z[i]
                            + A64 * bufs.soa.k[3].z[i]
                            + A65 * bufs.soa.k[4].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[5]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (B1 * bufs.soa.k[0].x[i]
                            + B3 * bufs.soa.k[2].x[i]
                            + B4 * bufs.soa.k[3].x[i]
                            + B5 * bufs.soa.k[4].x[i]
                            + B6 * bufs.soa.k[5].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (B1 * bufs.soa.k[0].y[i]
                            + B3 * bufs.soa.k[2].y[i]
                            + B4 * bufs.soa.k[3].y[i]
                            + B5 * bufs.soa.k[4].y[i]
                            + B6 * bufs.soa.k[5].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (B1 * bufs.soa.k[0].z[i]
                            + B3 * bufs.soa.k[2].z[i]
                            + B4 * bufs.soa.k[3].z[i]
                            + B5 * bufs.soa.k[4].z[i]
                            + B6 * bufs.soa.k[5].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }

            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[6]);
            rhs_evals.record();

            let error = self.max_error_norm_soa_buf(
                &[(0, E1), (2, E3), (3, E4), (4, E5), (5, E6), (6, E7)],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };
            let normalized_error = error / thr;
            let decision = if self.dynamics.adaptive_enabled {
                decide_adaptive_attempt(
                    dt,
                    normalized_error,
                    rhs_evals.finish(),
                    bufs,
                    &mut adaptive_controller,
                )
            } else {
                AdaptiveDecision::Accepted(dt)
            };

            if let AdaptiveDecision::Accepted(dt_next) = decision {
                bufs.soa
                    .m_stage
                    .gather_into_aos(&mut state.magnetization[..n]);
                state.time_seconds += dt;
                if dynamic_oersted {
                    state.k_fsal = None;
                } else if let Some(fsal) = &mut state.k_fsal {
                    bufs.soa.k[6].gather_into_aos(fsal);
                } else {
                    let mut fsal = vec![[0.0; 3]; n];
                    bufs.soa.k[6].gather_into_aos(&mut fsal);
                    state.k_fsal = Some(fsal);
                }
                let eval = self.compute_step_observables_at_time(
                    &state.magnetization,
                    ws,
                    &mut bufs.h_eff,
                    &mut bufs.h_scratch,
                    &mut bufs.rhs,
                    evaluation,
                    state.time_seconds,
                );
                state.adaptive_previous_error = if self.dynamics.adaptive_enabled {
                    adaptive_controller.previous_error()
                } else {
                    None
                };
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = self.dynamics.adaptive_enabled.then_some(dt_next);
                return Ok(report);
            }
            match decision {
                AdaptiveDecision::Retry(next) => dt = next,
                AdaptiveDecision::DtMinExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveDtMinExhausted,
                        "dt_min_exhausted",
                    ));
                }
                AdaptiveDecision::NonFinite(code) => {
                    return Err(crate::EngineError::with_code(
                        code,
                        "non_finite_adaptive_error",
                    ));
                }
                AdaptiveDecision::RetryLimitExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveRetryLimitExhausted,
                        "adaptive_retry_limit_exhausted",
                    ));
                }
                AdaptiveDecision::Accepted(_) => unreachable!("accepted decision returned above"),
            }
        }
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing ABM3 (Adams–Bashforth–Moulton 3rd order)
    // -----------------------------------------------------------------------
    pub(crate) fn abm3_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        let dt_changed = state.abm_history.requires_restart_for_dt(dt);

        // During startup, fall back to Heun to build history
        if dt_changed || !state.abm_history.is_ready() {
            bufs.m0[..n].copy_from_slice(&state.magnetization);

            // k1 = f(t, m0)
            self.effective_field_into_ws_at_time(&bufs.m0[..n], ws, &mut bufs.h_eff[..n], t0);
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m0[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[0][..n],
            );

            // predicted = normalize(m0 + dt * k1)
            {
                let (stage, m0, k0) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(k0.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, dt)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(k0[i], dt)))?;
                }
            }

            // k2 = f(t+dt, predicted)
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                t0 + dt,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[1][..n],
            );

            // corrected = normalize(m0 + dt/2 * (k1 + k2))
            {
                let (stage, m0, k0, k1) = (
                    &mut bufs.m_stage[..n],
                    &bufs.m0[..n],
                    &bufs.k[0][..n],
                    &bufs.k[1][..n],
                );
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(k0.par_iter())
                    .zip(k1.par_iter())
                    .try_for_each(|(((m, m0), k0), k1)| -> Result<()> {
                        *m = normalized(add(*m0, scale(add(*k0, *k1), 0.5 * dt)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(add(k0[i], k1[i]), 0.5 * dt)))?;
                }
            }
            self.restore_frozen_reference(&mut bufs.m_stage[..n]);
            let accepted_time = t0 + dt;

            // Store RHS at accepted point for history
            self.effective_field_into_ws_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff[..n],
                accepted_time,
            );
            self.llg_rhs_from_fields_with_direct_torques_into(
                &bufs.m_stage[..n],
                &bufs.h_eff[..n],
                &mut bufs.k[0][..n],
            );

            let eval = self.compute_step_observables_at_time(
                &bufs.m_stage[..n],
                ws,
                &mut bufs.h_eff,
                &mut bufs.h_scratch,
                &mut bufs.rhs,
                evaluation,
                accepted_time,
            );
            state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
            state.time_seconds = accepted_time;
            state.abm_history.push(bufs.k[0][..n].to_vec(), dt);
            return Ok(eval.into_step_report(accepted_time, dt, false));
        }

        // --- Full ABM3 step ---
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        let f_n = state.abm_history.f_n().unwrap();
        let f_n1 = state.abm_history.f_n_minus_1().unwrap();
        let f_n2 = state.abm_history.f_n_minus_2().unwrap();

        // Adams–Bashforth predictor → m_stage
        {
            let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .enumerate()
                .try_for_each(|(i, (s, m))| -> Result<()> {
                    let pred = add(
                        add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                        scale(f_n2[i], 5.0 / 12.0),
                    );
                    *s = normalized(add(*m, scale(pred, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                let pred = add(
                    add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                    scale(f_n2[i], 5.0 / 12.0),
                );
                stage[i] = normalized(add(m0[i], scale(pred, dt)))?;
            }
        }

        // Evaluate RHS at predicted point → k[0]
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);
        self.effective_field_into_ws_at_time(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n], t0 + dt);
        self.llg_rhs_from_fields_with_direct_torques_into(
            &bufs.m_stage[..n],
            &bufs.h_eff[..n],
            &mut bufs.k[0][..n],
        );

        // Adams–Moulton corrector → trial candidate
        {
            let (stage, m0, k0) = (
                &mut bufs.m_stage[..n],
                &bufs.m0[..n],
                &bufs.k[0][..n],
            );
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .enumerate()
                .try_for_each(|(i, (m, m0))| -> Result<()> {
                    let corr = add(
                        add(scale(k0[i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                        scale(f_n1[i], -1.0 / 12.0),
                    );
                    *m = normalized(add(*m0, scale(corr, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                let corr = add(
                    add(scale(k0[i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                    scale(f_n1[i], -1.0 / 12.0),
                );
                stage[i] = normalized(add(m0[i], scale(corr, dt)))?;
            }
        }
        self.restore_frozen_reference(&mut bufs.m_stage[..n]);
        let accepted_time = t0 + dt;

        let eval = self.compute_step_observables_at_time(
            &bufs.m_stage[..n],
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
            evaluation,
            accepted_time,
        );
        state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
        state.time_seconds = accepted_time;
        state.abm_history.push(bufs.k[0][..n].to_vec(), dt);
        Ok(eval.into_step_report(accepted_time, dt, false))
    }

    pub(crate) fn abm3_step_soa_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        let dt_changed = state.abm_history.requires_restart_for_dt(dt);

        if dt_changed || !state.abm_history.is_ready() {
            let mut trial_state = state.clone();
            if dt_changed {
                trial_state.abm_history.restart();
            }
            let report = self.heun_step_soa_buf(&mut trial_state, dt, ws, bufs, evaluation)?;

            bufs.soa.m0.scatter_from_aos(&trial_state.magnetization);
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m0,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);
            bufs.soa.k[0].gather_into_aos(&mut bufs.k[0][..n]);
            trial_state
                .abm_history
                .push_copy_from_slice(&bufs.k[0][..n], dt);
            *state = trial_state;

            return Ok(report);
        }

        bufs.soa.m0.scatter_from_aos(&state.magnetization);
        bufs.soa.k[1].scatter_from_aos(state.abm_history.f_n().unwrap());
        bufs.soa.k[2].scatter_from_aos(state.abm_history.f_n_minus_1().unwrap());
        bufs.soa.k[3].scatter_from_aos(state.abm_history.f_n_minus_2().unwrap());

        for i in 0..n {
            let pred_x = (23.0 / 12.0) * bufs.soa.k[1].x[i] - (16.0 / 12.0) * bufs.soa.k[2].x[i]
                + (5.0 / 12.0) * bufs.soa.k[3].x[i];
            let pred_y = (23.0 / 12.0) * bufs.soa.k[1].y[i] - (16.0 / 12.0) * bufs.soa.k[2].y[i]
                + (5.0 / 12.0) * bufs.soa.k[3].y[i];
            let pred_z = (23.0 / 12.0) * bufs.soa.k[1].z[i] - (16.0 / 12.0) * bufs.soa.k[2].z[i]
                + (5.0 / 12.0) * bufs.soa.k[3].z[i];
            let stage = normalized([
                bufs.soa.m0.x[i] + dt * pred_x,
                bufs.soa.m0.y[i] + dt * pred_y,
                bufs.soa.m0.z[i] + dt * pred_z,
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }

        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[0]);

        for i in 0..n {
            let corr_x = (5.0 / 12.0) * bufs.soa.k[0].x[i] + (8.0 / 12.0) * bufs.soa.k[1].x[i]
                - (1.0 / 12.0) * bufs.soa.k[2].x[i];
            let corr_y = (5.0 / 12.0) * bufs.soa.k[0].y[i] + (8.0 / 12.0) * bufs.soa.k[1].y[i]
                - (1.0 / 12.0) * bufs.soa.k[2].y[i];
            let corr_z = (5.0 / 12.0) * bufs.soa.k[0].z[i] + (8.0 / 12.0) * bufs.soa.k[1].z[i]
                - (1.0 / 12.0) * bufs.soa.k[2].z[i];
            let corrected = normalized([
                bufs.soa.m0.x[i] + dt * corr_x,
                bufs.soa.m0.y[i] + dt * corr_y,
                bufs.soa.m0.z[i] + dt * corr_z,
            ])?;
            bufs.soa.m_stage.x[i] = corrected[0];
            bufs.soa.m_stage.y[i] = corrected[1];
            bufs.soa.m_stage.z[i] = corrected[2];
        }

        bufs.soa.k[0].gather_into_aos(&mut bufs.k[0][..n]);

        let accepted_time = t0 + dt;
        let eval = {
            let soa = &mut bufs.soa;
            let (rhs_slots, scratch_slots) = soa.k.split_at_mut(1);
            self.compute_step_observables_soa_parts(
                &soa.m_stage,
                ws,
                &mut soa.h_eff,
                &mut rhs_slots[0],
                &mut scratch_slots[0],
                evaluation,
                accepted_time,
            )
        };
        bufs.soa.m_stage.gather_into_aos(&mut state.magnetization[..n]);
        state.time_seconds = accepted_time;
        state.abm_history.push_copy_from_slice(&bufs.k[0][..n], dt);
        Ok(eval.into_step_report(accepted_time, dt, false))
    }

    pub(crate) fn heun_step_soa_state_buf(
        &self,
        state: &mut ExchangeLlgStateSoA,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.soa.m0.copy_from(&state.magnetization);

        self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
        self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);

        for i in 0..n {
            let predicted = normalized([
                bufs.soa.m0.x[i] + dt * bufs.soa.k[0].x[i],
                bufs.soa.m0.y[i] + dt * bufs.soa.k[0].y[i],
                bufs.soa.m0.z[i] + dt * bufs.soa.k[0].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = predicted[0];
            bufs.soa.m_stage.y[i] = predicted[1];
            bufs.soa.m_stage.z[i] = predicted[2];
        }

        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);

        for i in 0..n {
            let corrected = normalized([
                bufs.soa.m0.x[i] + 0.5 * dt * (bufs.soa.k[0].x[i] + bufs.soa.k[1].x[i]),
                bufs.soa.m0.y[i] + 0.5 * dt * (bufs.soa.k[0].y[i] + bufs.soa.k[1].y[i]),
                bufs.soa.m0.z[i] + 0.5 * dt * (bufs.soa.k[0].z[i] + bufs.soa.k[1].z[i]),
            ])?;
            state.magnetization.x[i] = corrected[0];
            state.magnetization.y[i] = corrected[1];
            state.magnetization.z[i] = corrected[2];
        }
        state.time_seconds += dt;

        let eval = self.compute_step_observables_soa(
            &state.magnetization,
            ws,
            bufs,
            evaluation,
            state.time_seconds,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    pub(crate) fn rk4_step_soa_state_buf(
        &self,
        state: &mut ExchangeLlgStateSoA,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.soa.m0.copy_from(&state.magnetization);

        self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
        self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);

        for i in 0..n {
            let stage = normalized([
                bufs.soa.m0.x[i] + 0.5 * dt * bufs.soa.k[0].x[i],
                bufs.soa.m0.y[i] + 0.5 * dt * bufs.soa.k[0].y[i],
                bufs.soa.m0.z[i] + 0.5 * dt * bufs.soa.k[0].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }
        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + 0.5 * dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);

        for i in 0..n {
            let stage = normalized([
                bufs.soa.m0.x[i] + 0.5 * dt * bufs.soa.k[1].x[i],
                bufs.soa.m0.y[i] + 0.5 * dt * bufs.soa.k[1].y[i],
                bufs.soa.m0.z[i] + 0.5 * dt * bufs.soa.k[1].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }
        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + 0.5 * dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[2]);

        for i in 0..n {
            let stage = normalized([
                bufs.soa.m0.x[i] + dt * bufs.soa.k[2].x[i],
                bufs.soa.m0.y[i] + dt * bufs.soa.k[2].y[i],
                bufs.soa.m0.z[i] + dt * bufs.soa.k[2].z[i],
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }
        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[3]);

        let dt6 = dt / 6.0;
        for i in 0..n {
            let weighted_x = (bufs.soa.k[0].x[i] + 2.0 * bufs.soa.k[1].x[i])
                + (2.0 * bufs.soa.k[2].x[i] + bufs.soa.k[3].x[i]);
            let weighted_y = (bufs.soa.k[0].y[i] + 2.0 * bufs.soa.k[1].y[i])
                + (2.0 * bufs.soa.k[2].y[i] + bufs.soa.k[3].y[i]);
            let weighted_z = (bufs.soa.k[0].z[i] + 2.0 * bufs.soa.k[1].z[i])
                + (2.0 * bufs.soa.k[2].z[i] + bufs.soa.k[3].z[i]);
            let updated = normalized([
                bufs.soa.m0.x[i] + dt6 * weighted_x,
                bufs.soa.m0.y[i] + dt6 * weighted_y,
                bufs.soa.m0.z[i] + dt6 * weighted_z,
            ])?;
            state.magnetization.x[i] = updated[0];
            state.magnetization.y[i] = updated[1];
            state.magnetization.z[i] = updated[2];
        }
        state.time_seconds += dt;

        let eval = self.compute_step_observables_soa(
            &state.magnetization,
            ws,
            bufs,
            evaluation,
            state.time_seconds,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    pub(crate) fn rk23_step_soa_state_buf(
        &self,
        state: &mut ExchangeLlgStateSoA,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        if !self.dynamics.adaptive_enabled {
            let mut aos = state.to_aos();
            let report = self.rk23_step_soa_buf(&mut aos, dt, ws, bufs, evaluation)?;
            *state = aos.to_soa();
            return Ok(report);
        }
        let cfg = self.dynamics.adaptive;
        let mut adaptive_controller =
            AdaptiveStepController::new(2, cfg, state.adaptive_previous_error);
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        bufs.soa.m0.copy_from(&state.magnetization);

        loop {
            self.set_thermal_dt_for_attempt(dt);
            let mut rhs_evals = AttemptRhsCounter::default();
            self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
            self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + 0.5 * dt * bufs.soa.k[0].x[i],
                    bufs.soa.m0.y[i] + 0.5 * dt * bufs.soa.k[0].y[i],
                    bufs.soa.m0.z[i] + 0.5 * dt * bufs.soa.k[0].z[i],
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + 0.5 * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + 0.75 * dt * bufs.soa.k[1].x[i],
                    bufs.soa.m0.y[i] + 0.75 * dt * bufs.soa.k[1].y[i],
                    bufs.soa.m0.z[i] + 0.75 * dt * bufs.soa.k[1].z[i],
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + 0.75 * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[2]);
            rhs_evals.record();

            for i in 0..n {
                let weighted_x = (2.0 / 9.0) * bufs.soa.k[0].x[i]
                    + (1.0 / 3.0) * bufs.soa.k[1].x[i]
                    + (4.0 / 9.0) * bufs.soa.k[2].x[i];
                let weighted_y = (2.0 / 9.0) * bufs.soa.k[0].y[i]
                    + (1.0 / 3.0) * bufs.soa.k[1].y[i]
                    + (4.0 / 9.0) * bufs.soa.k[2].y[i];
                let weighted_z = (2.0 / 9.0) * bufs.soa.k[0].z[i]
                    + (1.0 / 3.0) * bufs.soa.k[1].z[i]
                    + (4.0 / 9.0) * bufs.soa.k[2].z[i];
                let stage = normalized([
                    bufs.soa.m0.x[i] + dt * weighted_x,
                    bufs.soa.m0.y[i] + dt * weighted_y,
                    bufs.soa.m0.z[i] + dt * weighted_z,
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }

            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[3]);
            rhs_evals.record();

            let error = self.max_error_norm_soa_buf(
                &[
                    (0, -5.0 / 72.0),
                    (1, 1.0 / 12.0),
                    (2, 1.0 / 9.0),
                    (3, -1.0 / 8.0),
                ],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };
            let normalized_error = error / thr;
            let decision = if self.dynamics.adaptive_enabled {
                decide_adaptive_attempt(
                    dt,
                    normalized_error,
                    rhs_evals.finish(),
                    bufs,
                    &mut adaptive_controller,
                )
            } else {
                AdaptiveDecision::Accepted(dt)
            };

            if let AdaptiveDecision::Accepted(dt_next) = decision {
                state.magnetization.copy_from(&bufs.soa.m_stage);
                state.time_seconds += dt;
                let eval = self.compute_step_observables_soa(
                    &state.magnetization,
                    ws,
                    bufs,
                    evaluation,
                    state.time_seconds,
                );
                state.adaptive_previous_error = if self.dynamics.adaptive_enabled {
                    adaptive_controller.previous_error()
                } else {
                    None
                };
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = self.dynamics.adaptive_enabled.then_some(dt_next);
                return Ok(report);
            }
            match decision {
                AdaptiveDecision::Retry(next) => dt = next,
                AdaptiveDecision::DtMinExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveDtMinExhausted,
                        "dt_min_exhausted",
                    ));
                }
                AdaptiveDecision::NonFinite(code) => {
                    return Err(crate::EngineError::with_code(
                        code,
                        "non_finite_adaptive_error",
                    ));
                }
                AdaptiveDecision::RetryLimitExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveRetryLimitExhausted,
                        "adaptive_retry_limit_exhausted",
                    ));
                }
                AdaptiveDecision::Accepted(_) => unreachable!("accepted decision returned above"),
            }
        }
    }

    pub(crate) fn rk45_step_soa_state_buf(
        &self,
        state: &mut ExchangeLlgStateSoA,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        if !self.dynamics.adaptive_enabled {
            let mut aos = state.to_aos();
            let report = self.rk45_step_soa_buf(&mut aos, dt, ws, bufs, evaluation)?;
            *state = aos.to_soa();
            return Ok(report);
        }
        let cfg = self.dynamics.adaptive;
        let mut adaptive_controller =
            AdaptiveStepController::new(4, cfg, state.adaptive_previous_error);
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        let dynamic_oersted = self
            .terms
            .oersted_cylinder
            .as_ref()
            .is_some_and(|cfg| cfg.time_dep_kind != 0);
        bufs.soa.m0.copy_from(&state.magnetization);

        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            self.set_thermal_dt_for_attempt(dt);
            let mut rhs_evals = AttemptRhsCounter::default();
            let reusable_fsal = (!dynamic_oersted).then(|| state.k_fsal.as_ref()).flatten();
            if let Some(fsal) = reusable_fsal {
                bufs.soa.k[0].copy_from(&fsal);
            } else {
                self.effective_field_into_soa_ws_at_time(&bufs.soa.m0, ws, &mut bufs.soa.h_eff, t0);
                self.llg_rhs_soa_into(&bufs.soa.m0, &bufs.soa.h_eff, &mut bufs.soa.k[0]);
                rhs_evals.record();
            }

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + dt * A21 * bufs.soa.k[0].x[i],
                    bufs.soa.m0.y[i] + dt * A21 * bufs.soa.k[0].y[i],
                    bufs.soa.m0.z[i] + dt * A21 * bufs.soa.k[0].z[i],
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (1.0 / 5.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[1]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i] + dt * (A31 * bufs.soa.k[0].x[i] + A32 * bufs.soa.k[1].x[i]),
                    bufs.soa.m0.y[i] + dt * (A31 * bufs.soa.k[0].y[i] + A32 * bufs.soa.k[1].y[i]),
                    bufs.soa.m0.z[i] + dt * (A31 * bufs.soa.k[0].z[i] + A32 * bufs.soa.k[1].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (3.0 / 10.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[2]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (A41 * bufs.soa.k[0].x[i]
                            + A42 * bufs.soa.k[1].x[i]
                            + A43 * bufs.soa.k[2].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (A41 * bufs.soa.k[0].y[i]
                            + A42 * bufs.soa.k[1].y[i]
                            + A43 * bufs.soa.k[2].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (A41 * bufs.soa.k[0].z[i]
                            + A42 * bufs.soa.k[1].z[i]
                            + A43 * bufs.soa.k[2].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (4.0 / 5.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[3]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (A51 * bufs.soa.k[0].x[i]
                            + A52 * bufs.soa.k[1].x[i]
                            + A53 * bufs.soa.k[2].x[i]
                            + A54 * bufs.soa.k[3].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (A51 * bufs.soa.k[0].y[i]
                            + A52 * bufs.soa.k[1].y[i]
                            + A53 * bufs.soa.k[2].y[i]
                            + A54 * bufs.soa.k[3].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (A51 * bufs.soa.k[0].z[i]
                            + A52 * bufs.soa.k[1].z[i]
                            + A53 * bufs.soa.k[2].z[i]
                            + A54 * bufs.soa.k[3].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + (8.0 / 9.0) * dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[4]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (A61 * bufs.soa.k[0].x[i]
                            + A62 * bufs.soa.k[1].x[i]
                            + A63 * bufs.soa.k[2].x[i]
                            + A64 * bufs.soa.k[3].x[i]
                            + A65 * bufs.soa.k[4].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (A61 * bufs.soa.k[0].y[i]
                            + A62 * bufs.soa.k[1].y[i]
                            + A63 * bufs.soa.k[2].y[i]
                            + A64 * bufs.soa.k[3].y[i]
                            + A65 * bufs.soa.k[4].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (A61 * bufs.soa.k[0].z[i]
                            + A62 * bufs.soa.k[1].z[i]
                            + A63 * bufs.soa.k[2].z[i]
                            + A64 * bufs.soa.k[3].z[i]
                            + A65 * bufs.soa.k[4].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }
            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[5]);
            rhs_evals.record();

            for i in 0..n {
                let stage = normalized([
                    bufs.soa.m0.x[i]
                        + dt * (B1 * bufs.soa.k[0].x[i]
                            + B3 * bufs.soa.k[2].x[i]
                            + B4 * bufs.soa.k[3].x[i]
                            + B5 * bufs.soa.k[4].x[i]
                            + B6 * bufs.soa.k[5].x[i]),
                    bufs.soa.m0.y[i]
                        + dt * (B1 * bufs.soa.k[0].y[i]
                            + B3 * bufs.soa.k[2].y[i]
                            + B4 * bufs.soa.k[3].y[i]
                            + B5 * bufs.soa.k[4].y[i]
                            + B6 * bufs.soa.k[5].y[i]),
                    bufs.soa.m0.z[i]
                        + dt * (B1 * bufs.soa.k[0].z[i]
                            + B3 * bufs.soa.k[2].z[i]
                            + B4 * bufs.soa.k[3].z[i]
                            + B5 * bufs.soa.k[4].z[i]
                            + B6 * bufs.soa.k[5].z[i]),
                ])?;
                bufs.soa.m_stage.x[i] = stage[0];
                bufs.soa.m_stage.y[i] = stage[1];
                bufs.soa.m_stage.z[i] = stage[2];
            }

            self.effective_field_into_soa_ws_at_time(
                &bufs.soa.m_stage,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[6]);
            rhs_evals.record();

            let error = self.max_error_norm_soa_buf(
                &[(0, E1), (2, E3), (3, E4), (4, E5), (5, E6), (6, E7)],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };
            let normalized_error = error / thr;
            let decision = if self.dynamics.adaptive_enabled {
                decide_adaptive_attempt(
                    dt,
                    normalized_error,
                    rhs_evals.finish(),
                    bufs,
                    &mut adaptive_controller,
                )
            } else {
                AdaptiveDecision::Accepted(dt)
            };

            if let AdaptiveDecision::Accepted(dt_next) = decision {
                state.magnetization.copy_from(&bufs.soa.m_stage);
                state.time_seconds += dt;
                if dynamic_oersted {
                    state.k_fsal = None;
                } else if let Some(fsal) = &mut state.k_fsal {
                    fsal.copy_from(&bufs.soa.k[6]);
                } else {
                    state.k_fsal = Some(bufs.soa.k[6].clone());
                }
                let eval = self.compute_step_observables_soa(
                    &state.magnetization,
                    ws,
                    bufs,
                    evaluation,
                    state.time_seconds,
                );
                state.adaptive_previous_error = if self.dynamics.adaptive_enabled {
                    adaptive_controller.previous_error()
                } else {
                    None
                };
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = self.dynamics.adaptive_enabled.then_some(dt_next);
                return Ok(report);
            }
            match decision {
                AdaptiveDecision::Retry(next) => dt = next,
                AdaptiveDecision::DtMinExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveDtMinExhausted,
                        "dt_min_exhausted",
                    ));
                }
                AdaptiveDecision::NonFinite(code) => {
                    return Err(crate::EngineError::with_code(
                        code,
                        "non_finite_adaptive_error",
                    ));
                }
                AdaptiveDecision::RetryLimitExhausted => {
                    return Err(crate::EngineError::with_code(
                        crate::EngineErrorCode::AdaptiveRetryLimitExhausted,
                        "adaptive_retry_limit_exhausted",
                    ));
                }
                AdaptiveDecision::Accepted(_) => unreachable!("accepted decision returned above"),
            }
        }
    }

    pub(crate) fn abm3_step_soa_state_buf(
        &self,
        state: &mut ExchangeLlgStateSoA,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let t0 = state.time_seconds;
        let dt_changed = state.abm_history.requires_restart_for_dt(dt);

        if dt_changed || !state.abm_history.is_ready() {
            let mut trial_state = state.clone();
            if dt_changed {
                trial_state.abm_history.restart();
            }
            let report =
                self.heun_step_soa_state_buf(&mut trial_state, dt, ws, bufs, evaluation)?;

            self.effective_field_into_soa_ws_at_time(
                &trial_state.magnetization,
                ws,
                &mut bufs.soa.h_eff,
                t0 + dt,
            );
            self.llg_rhs_soa_into(
                &trial_state.magnetization,
                &bufs.soa.h_eff,
                &mut bufs.soa.k[0],
            );
            trial_state.abm_history.push_copy_from_soa(&bufs.soa.k[0], dt);
            *state = trial_state;

            return Ok(report);
        }

        bufs.soa.m0.copy_from(&state.magnetization);
        bufs.soa.k[1].copy_from(state.abm_history.f_n().expect("ABM SoA f_n missing"));
        bufs.soa.k[2].copy_from(
            state
                .abm_history
                .f_n_minus_1()
                .expect("ABM SoA f_n_minus_1 missing"),
        );
        bufs.soa.k[3].copy_from(
            state
                .abm_history
                .f_n_minus_2()
                .expect("ABM SoA f_n_minus_2 missing"),
        );

        for i in 0..n {
            let pred_x = (23.0 / 12.0) * bufs.soa.k[1].x[i] - (16.0 / 12.0) * bufs.soa.k[2].x[i]
                + (5.0 / 12.0) * bufs.soa.k[3].x[i];
            let pred_y = (23.0 / 12.0) * bufs.soa.k[1].y[i] - (16.0 / 12.0) * bufs.soa.k[2].y[i]
                + (5.0 / 12.0) * bufs.soa.k[3].y[i];
            let pred_z = (23.0 / 12.0) * bufs.soa.k[1].z[i] - (16.0 / 12.0) * bufs.soa.k[2].z[i]
                + (5.0 / 12.0) * bufs.soa.k[3].z[i];
            let stage = normalized([
                bufs.soa.m0.x[i] + dt * pred_x,
                bufs.soa.m0.y[i] + dt * pred_y,
                bufs.soa.m0.z[i] + dt * pred_z,
            ])?;
            bufs.soa.m_stage.x[i] = stage[0];
            bufs.soa.m_stage.y[i] = stage[1];
            bufs.soa.m_stage.z[i] = stage[2];
        }

        self.effective_field_into_soa_ws_at_time(
            &bufs.soa.m_stage,
            ws,
            &mut bufs.soa.h_eff,
            t0 + dt,
        );
        self.llg_rhs_soa_into(&bufs.soa.m_stage, &bufs.soa.h_eff, &mut bufs.soa.k[0]);

        for i in 0..n {
            let corr_x = (5.0 / 12.0) * bufs.soa.k[0].x[i] + (8.0 / 12.0) * bufs.soa.k[1].x[i]
                - (1.0 / 12.0) * bufs.soa.k[2].x[i];
            let corr_y = (5.0 / 12.0) * bufs.soa.k[0].y[i] + (8.0 / 12.0) * bufs.soa.k[1].y[i]
                - (1.0 / 12.0) * bufs.soa.k[2].y[i];
            let corr_z = (5.0 / 12.0) * bufs.soa.k[0].z[i] + (8.0 / 12.0) * bufs.soa.k[1].z[i]
                - (1.0 / 12.0) * bufs.soa.k[2].z[i];
            let updated = normalized([
                bufs.soa.m0.x[i] + dt * corr_x,
                bufs.soa.m0.y[i] + dt * corr_y,
                bufs.soa.m0.z[i] + dt * corr_z,
            ])?;
            bufs.soa.m_stage.x[i] = updated[0];
            bufs.soa.m_stage.y[i] = updated[1];
            bufs.soa.m_stage.z[i] = updated[2];
        }
        let accepted_time = t0 + dt;
        {
            let (rhs_slots, scratch_slots) = bufs.soa.k.split_at_mut(1);
            scratch_slots[5].copy_from(&rhs_slots[0]);
        }

        let eval = {
            let soa = &mut bufs.soa;
            let (rhs_slots, scratch_slots) = soa.k.split_at_mut(1);
            self.compute_step_observables_soa_parts(
                &soa.m_stage,
                ws,
                &mut soa.h_eff,
                &mut rhs_slots[0],
                &mut scratch_slots[0],
                evaluation,
                accepted_time,
            )
        };
        state.magnetization.copy_from(&bufs.soa.m_stage);
        state.time_seconds = accepted_time;
        state.abm_history.push_copy_from_soa(&bufs.soa.k[6], dt);
        Ok(eval.into_step_report(accepted_time, dt, false))
    }

    fn compute_step_observables_soa(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
        time_seconds: f64,
    ) -> RhsEvaluation {
        let soa = &mut bufs.soa;
        let (rhs_slots, scratch_slots) = soa.k.split_at_mut(1);
        self.compute_step_observables_soa_parts(
            magnetization,
            ws,
            &mut soa.h_eff,
            &mut rhs_slots[0],
            &mut scratch_slots[0],
            evaluation,
            time_seconds,
        )
    }

    fn compute_step_observables_soa_parts(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        h_eff: &mut VectorFieldSoA,
        rhs_out: &mut VectorFieldSoA,
        h_scratch: &mut VectorFieldSoA,
        evaluation: EvaluationRequest,
        time_seconds: f64,
    ) -> RhsEvaluation {
        match evaluation {
            EvaluationRequest::Minimal => self.compute_step_observables_soa_minimal(
                magnetization,
                ws,
                h_eff,
                rhs_out,
                time_seconds,
            ),
            EvaluationRequest::Full => self.compute_step_observables_soa_full(
                magnetization,
                ws,
                h_eff,
                rhs_out,
                h_scratch,
                time_seconds,
            ),
        }
    }

    #[allow(non_snake_case)]
    fn compute_step_observables_soa_full(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        h_eff: &mut VectorFieldSoA,
        rhs_out: &mut VectorFieldSoA,
        h_scratch: &mut VectorFieldSoA,
        time_seconds: f64,
    ) -> RhsEvaluation {
        h_eff.fill_zero();

        let exchange_energy_joules = if self.terms.exchange {
            h_scratch.fill_zero();
            self.exchange_field_add_into_soa(magnetization, h_scratch);
            let energy = self.half_field_energy_from_soa(magnetization, h_scratch);
            add_soa_into(h_eff, h_scratch);
            energy
        } else {
            0.0
        };

        let (demag_energy_joules, max_demag_field_amplitude) = if self.terms.demag {
            h_scratch.fill_zero();
            self.demag_field_add_into_soa_fft_backend(magnetization, ws, h_scratch);
            let energy = self.half_field_energy_from_soa(magnetization, h_scratch);
            let max_field = max_norm_soa(h_scratch);
            add_soa_into(h_eff, h_scratch);
            (energy, max_field)
        } else {
            (0.0, 0.0)
        };

        let external_energy_joules = if self.has_external_zeeman_source() {
            h_scratch.fill_zero();
            self.external_field_add_into_soa(h_scratch);
            self.oersted_field_add_into_soa_at_time(h_scratch, time_seconds);
            let energy = self.full_field_energy_from_soa(magnetization, h_scratch);
            add_soa_into(h_eff, h_scratch);
            energy
        } else {
            0.0
        };

        self.magnetoelastic_field_add_into_soa(magnetization, h_eff);
        self.anisotropy_field_add_into_soa(magnetization, h_eff);
        self.interfacial_dmi_field_add_into_soa(magnetization, h_eff);
        self.bulk_dmi_field_add_into_soa(magnetization, h_eff);
        self.thermal_field_add_into_soa(h_eff);

        let mel_energy_joules = self.magnetoelastic_energy_soa(magnetization);
        let ani_energy_joules = self.anisotropy_energy_from_soa(magnetization);
        let dmi_energy_joules = self.dmi_energy_from_soa(magnetization);

        let max_effective_field_amplitude = max_norm_soa(h_eff);

        self.llg_rhs_soa_into(magnetization, h_eff, rhs_out);

        let max_rhs_amplitude = max_norm_soa(rhs_out);
        let max_torque_apm = max_cross_norm_soa(magnetization, h_eff);

        RhsEvaluation {
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            anisotropy_energy_joules: ani_energy_joules,
            dmi_energy_joules,
            total_energy_joules: exchange_energy_joules
                + demag_energy_joules
                + external_energy_joules
                + mel_energy_joules
                + ani_energy_joules
                + dmi_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_rhs_all_amplitude: max_rhs_amplitude,
            max_torque_Apm: max_torque_apm,
            max_torque_all_Apm: max_torque_apm,
        }
    }

    fn compute_step_observables_soa_minimal(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        h_eff: &mut VectorFieldSoA,
        rhs_out: &mut VectorFieldSoA,
        time_seconds: f64,
    ) -> RhsEvaluation {
        self.effective_field_into_soa_ws_at_time(magnetization, ws, h_eff, time_seconds);
        let max_effective_field_amplitude = max_norm_soa(h_eff);

        self.llg_rhs_soa_into(magnetization, h_eff, rhs_out);

        let max_rhs_amplitude = max_norm_soa(rhs_out);
        let max_torque_apm = max_cross_norm_soa(magnetization, h_eff);

        RhsEvaluation {
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude,
            max_rhs_all_amplitude: max_rhs_amplitude,
            max_torque_Apm: max_torque_apm,
            max_torque_all_Apm: max_torque_apm,
        }
    }

    // -----------------------------------------------------------------------
    // Error norm from buffer-indexed k-stages
    // -----------------------------------------------------------------------
    pub(crate) fn max_error_norm_buf(
        &self,
        weighted_stages: &[(usize, f64)],
        bufs: &mut IntegratorBuffers,
        dt: f64,
        n: usize,
    ) -> f64 {
        #[cfg(test)]
        if let Some(error) = bufs.take_adaptive_error_for_tests() {
            return error;
        }
        let cfg = self.dynamics.adaptive;
        let use_rtol = cfg.rtol > 0.0;
        let atol = cfg.max_error;
        let rtol = cfg.rtol;

        let compute_err = |i: usize| -> f64 {
            let mut err = [0.0, 0.0, 0.0];
            for &(k_idx, w) in weighted_stages {
                err[0] += w * bufs.k[k_idx][i][0];
                err[1] += w * bufs.k[k_idx][i][1];
                err[2] += w * bufs.k[k_idx][i][2];
            }
            err[0] *= dt;
            err[1] *= dt;
            err[2] *= dt;
            if use_rtol {
                let y_norm = norm(bufs.m0[i]).max(norm(bufs.m_stage[i])).max(1e-30);
                let sc = atol + rtol * y_norm;
                norm(err) / sc
            } else {
                norm(err)
            }
        };

        #[cfg(feature = "parallel")]
        {
            (0..n)
                .into_par_iter()
                .map(compute_err)
                .reduce(|| 0.0f64, max_error_preserving_nonfinite)
        }
        #[cfg(not(feature = "parallel"))]
        {
            let mut max_err = 0.0f64;
            for i in 0..n {
                let error = compute_err(i);
                if !error.is_finite() {
                    return error;
                }
                max_err = max_err.max(error);
            }
            max_err
        }
    }

    pub(crate) fn max_error_norm_soa_buf(
        &self,
        weighted_stages: &[(usize, f64)],
        bufs: &mut IntegratorBuffers,
        dt: f64,
        n: usize,
    ) -> f64 {
        #[cfg(test)]
        if let Some(error) = bufs.take_adaptive_error_for_tests() {
            return error;
        }
        let cfg = self.dynamics.adaptive;
        let use_rtol = cfg.rtol > 0.0;
        let atol = cfg.max_error;
        let rtol = cfg.rtol;

        let compute_err = |i: usize| -> f64 {
            let mut err = [0.0, 0.0, 0.0];
            for &(k_idx, w) in weighted_stages {
                err[0] += w * bufs.soa.k[k_idx].x[i];
                err[1] += w * bufs.soa.k[k_idx].y[i];
                err[2] += w * bufs.soa.k[k_idx].z[i];
            }
            err[0] *= dt;
            err[1] *= dt;
            err[2] *= dt;
            if use_rtol {
                let y_norm = norm([bufs.soa.m0.x[i], bufs.soa.m0.y[i], bufs.soa.m0.z[i]])
                    .max(norm([
                        bufs.soa.m_stage.x[i],
                        bufs.soa.m_stage.y[i],
                        bufs.soa.m_stage.z[i],
                    ]))
                    .max(1e-30);
                let sc = atol + rtol * y_norm;
                norm(err) / sc
            } else {
                norm(err)
            }
        };

        #[cfg(feature = "parallel")]
        {
            (0..n)
                .into_par_iter()
                .map(compute_err)
                .reduce(|| 0.0f64, max_error_preserving_nonfinite)
        }
        #[cfg(not(feature = "parallel"))]
        {
            let mut max_err = 0.0f64;
            for i in 0..n {
                let error = compute_err(i);
                if !error.is_finite() {
                    return error;
                }
                max_err = max_err.max(error);
            }
            max_err
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct FinalRhsReductions {
    max_rhs_free_amplitude: f64,
    max_rhs_all_amplitude: f64,
    max_torque_free_apm: f64,
    max_torque_all_apm: f64,
}

/// One coupled-stage RHS owner: assemble all field and direct contributions,
/// then apply the frozen-spin final mask exactly once.
fn apply_external_stage_terms<F>(
    magnetization: &[Vector3],
    field: &mut [Vector3],
    rhs: &mut [Vector3],
    terms: ExternalStageTerms,
    frozen_spins: Option<&crate::FrozenSpinsState>,
    llg_rhs: F,
) -> Result<FinalRhsReductions>
where
    F: FnOnce(&[Vector3], &[Vector3], &mut [Vector3]),
{
    let n = magnetization.len();
    if terms.additional_field_apm.len() != n || terms.direct_torque_per_s.len() != n {
        return Err(crate::EngineError::with_code(
            crate::EngineErrorCode::InvalidInput,
            "external stage fields and torques must match the FDM grid",
        ));
    }
    if terms
        .additional_field_apm
        .iter()
        .chain(&terms.direct_torque_per_s)
        .flatten()
        .any(|value| !value.is_finite())
    {
        let code = if terms
            .additional_field_apm
            .iter()
            .chain(&terms.direct_torque_per_s)
            .flatten()
            .any(|value| value.is_nan())
        {
            crate::EngineErrorCode::NaNValue
        } else {
            crate::EngineErrorCode::InfiniteValue
        };
        return Err(crate::EngineError::with_code(
            code,
            "external stage fields and torques must be finite",
        ));
    }
    for (base, additional) in field.iter_mut().zip(&terms.additional_field_apm) {
        *base = add(*base, *additional);
    }
    llg_rhs(magnetization, field, rhs);
    for (value, direct) in rhs.iter_mut().zip(&terms.direct_torque_per_s) {
        *value = add(*value, *direct);
    }
    let max_rhs_all_amplitude = rhs.iter().map(|value| norm(*value)).fold(0.0, f64::max);
    let max_torque_all_apm = magnetization
        .iter()
        .zip(field.iter())
        .map(|(m, h)| norm(cross(*m, *h)))
        .fold(0.0, f64::max);
    let (max_rhs_free_amplitude, max_torque_free_apm) = if let Some(frozen) = frozen_spins {
        frozen.mask_final_rhs(rhs);
        (
            frozen.max_norm_free(rhs),
            frozen.max_cross_norm_free(magnetization, field),
        )
    } else {
        (max_rhs_all_amplitude, max_torque_all_apm)
    };
    Ok(FinalRhsReductions {
        max_rhs_free_amplitude,
        max_rhs_all_amplitude,
        max_torque_free_apm,
        max_torque_all_apm,
    })
}

fn max_norm_soa(field: &VectorFieldSoA) -> f64 {
    let mut max_value = 0.0f64;
    for i in 0..field.len() {
        max_value = max_value.max(norm([field.x[i], field.y[i], field.z[i]]));
    }
    max_value
}

fn max_cross_norm_soa(a: &VectorFieldSoA, b: &VectorFieldSoA) -> f64 {
    debug_assert_eq!(a.len(), b.len());
    let mut max_value = 0.0f64;
    for i in 0..a.len() {
        let cross = [
            a.y[i] * b.z[i] - a.z[i] * b.y[i],
            a.z[i] * b.x[i] - a.x[i] * b.z[i],
            a.x[i] * b.y[i] - a.y[i] * b.x[i],
        ];
        max_value = max_value.max(norm(cross));
    }
    max_value
}

fn add_soa_into(dst: &mut VectorFieldSoA, src: &VectorFieldSoA) {
    debug_assert!(dst.len() >= src.len());
    for i in 0..src.len() {
        dst.x[i] += src.x[i];
        dst.y[i] += src.y[i];
        dst.z[i] += src.z[i];
    }
}
