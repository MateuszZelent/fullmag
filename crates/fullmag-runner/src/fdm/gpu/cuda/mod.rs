#[cfg(feature = "cuda")]
pub(crate) mod artifacts;
#[cfg(any(feature = "cuda", test))]
pub(crate) mod charge_transport;
#[cfg(feature = "cuda")]
pub(crate) mod direct_minimizer;
pub(crate) mod execute;
#[cfg(test)]
#[path = "spin_transport_tests.rs"]
mod gpu_m1_transport_session;
#[cfg(feature = "cuda")]
pub(crate) mod live_observations;
#[cfg(feature = "cuda")]
pub(crate) mod multilayer;
pub(crate) mod native;
pub(crate) mod route;
#[cfg(any(feature = "cuda", test))]
#[allow(dead_code)]
pub(crate) mod spin_transport;
#[cfg(test)]
pub(crate) mod transport_publication;

/// The native FDM clock starts at zero for every execution.  `TimeStageContextIR`
/// still carries the physical start of the stage, so all Rust-side observables
/// must map the native clock back to the canonical absolute clock before they
/// evaluate an authored waveform or publish an antenna field.
pub(crate) fn canonical_fdm_time(plan: &fullmag_ir::FdmPlanIR, solver_time_s: f64) -> f64 {
    solver_time_s + plan.time_stage.start_time_s
}

/// Translate only published copies. Native integration, schedules and waveform
/// evaluation retain their stage-local clock; relaxation retains pseudo-time.
#[cfg(any(feature = "cuda", test))]
pub(crate) fn canonical_fdm_publication_time(plan: &fullmag_ir::FdmPlanIR, solver_time_s: f64) -> f64 {
    if plan.relaxation.is_none()
        && matches!(plan.time_stage.study_kind,
            fullmag_ir::StudyKindIR::TimeEvolution | fullmag_ir::StudyKindIR::Unknown)
    {
        canonical_fdm_time(plan, solver_time_s)
    } else {
        solver_time_s
    }
}

#[cfg(any(feature = "cuda", test))]
pub(crate) fn canonical_fdm_publication_stats(
    plan: &fullmag_ir::FdmPlanIR, mut stats: crate::types::StepStats,
) -> crate::types::StepStats {
    stats.time = canonical_fdm_publication_time(plan, stats.time);
    stats
}

#[cfg(any(feature = "cuda", test))]
pub(crate) fn canonical_fdm_publication_clock(
    plan: &fullmag_ir::FdmPlanIR, stats: &crate::types::StepStats,
) -> crate::ObservationClock {
    crate::ObservationClock {
        accepted_step: stats.step,
        time_seconds: canonical_fdm_publication_time(plan, stats.time),
        dt_seconds: (stats.dt > 0.0).then_some(stats.dt),
    }
}

#[cfg(test)]
mod publication_clock_tests {
    #[test]
    fn cuda_publication_clock_is_physical_before_digest_and_keeps_relaxation_local() {
        let mut plan = fullmag_ir::FdmPlanIR::default();
        plan.time_stage.start_time_s = 2e-12;
        plan.time_stage.study_kind = fullmag_ir::StudyKindIR::TimeEvolution;
        let local = crate::types::StepStats {step: 22, time: 3e-12, dt: 1e-14, ..Default::default()};
        let published = super::canonical_fdm_publication_stats(&plan, local.clone());
        let clock = super::canonical_fdm_publication_clock(&plan, &local);
        assert_eq!(local.time, 3e-12);
        assert_eq!(published.time, 2e-12 + 3e-12);
        assert_eq!(clock.time_seconds, published.time);
        assert_eq!(clock.accepted_step, local.step);
        assert_eq!(clock.dt_seconds, Some(local.dt));
        let snapshot = crate::FdmGpuAcceptedStateSnapshotV1::from_final_magnetization(clock, &[[1.0,0.0,0.0]]).unwrap();
        assert_eq!(snapshot.clock.time_seconds, published.time);
        assert_eq!(snapshot.clock_digest, snapshot.clock.digest().unwrap());
        let initial = crate::types::StepStats::default();
        assert_eq!(super::canonical_fdm_publication_clock(&plan, &initial).time_seconds, 2e-12);
        plan.time_stage.study_kind = fullmag_ir::StudyKindIR::Relaxation;
        assert_eq!(super::canonical_fdm_publication_stats(&plan, local.clone()).time, local.time);
        plan.time_stage.study_kind = fullmag_ir::StudyKindIR::Unknown;
        plan.relaxation = Some(fullmag_ir::RelaxationControlIR {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: None, energy_tolerance_j: None,
                max_steps: Some(1), max_relaxation_time_s: None,
            },
        });
        assert_eq!(super::canonical_fdm_publication_clock(&plan, &local).time_seconds, local.time);
    }
}

/// Return the authored waveform coordinate for a native FDM solver time.
pub(crate) fn canonical_fdm_waveform_time(
    plan: &fullmag_ir::FdmPlanIR,
    origin: fullmag_ir::FieldTimeOriginIR,
    solver_time_s: f64,
) -> f64 {
    match origin {
        fullmag_ir::FieldTimeOriginIR::StageLocal => {
            solver_time_s
                + (plan.time_stage.start_time_s - plan.time_stage.waveform_origin_time_s())
        }
        fullmag_ir::FieldTimeOriginIR::Absolute => canonical_fdm_time(plan, solver_time_s),
    }
}
