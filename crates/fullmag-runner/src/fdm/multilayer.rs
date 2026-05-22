//! Shared FDM multilayer runner helpers.

use crate::scalar_metrics::apply_average_m_to_step_stats;
use crate::types::{StateObservables, StepStats};

pub(crate) fn make_multilayer_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: solver_dt,
        e_ex: observables.exchange_energy,
        e_demag: observables.demag_energy,
        e_ext: observables.external_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = observables.per_object_scalars.clone();
    stats
}
