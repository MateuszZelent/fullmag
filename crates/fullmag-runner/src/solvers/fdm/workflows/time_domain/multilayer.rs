//! FDM multilayer time-domain workflow helpers.

use crate::scalar_metrics::weighted_average_m_from_object_scalars;
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
        e_ani: observables.anisotropy_energy,
        e_dmi: observables.dmi_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_rhs_norm_per_s: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        max_torque_Apm: observables.max_torque_Apm,
        max_torque_T: observables.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    stats.per_object_scalars = observables.per_object_scalars.clone();
    let averaged = weighted_average_m_from_object_scalars(&stats.per_object_scalars)
        .unwrap_or_else(|| {
            crate::scalar_metrics::average_magnetization_components(&observables.magnetization)
        });
    stats.mx = averaged[0];
    stats.my = averaged[1];
    stats.mz = averaged[2];
    stats
}
