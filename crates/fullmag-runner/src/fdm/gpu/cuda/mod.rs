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

/// Return the authored waveform coordinate for a native FDM solver time.
pub(crate) fn canonical_fdm_waveform_time(
    plan: &fullmag_ir::FdmPlanIR,
    origin: fullmag_ir::FieldTimeOriginIR,
    solver_time_s: f64,
) -> f64 {
    match origin {
        fullmag_ir::FieldTimeOriginIR::StageLocal => solver_time_s,
        fullmag_ir::FieldTimeOriginIR::Absolute => canonical_fdm_time(plan, solver_time_s),
    }
}
