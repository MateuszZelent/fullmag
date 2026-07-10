use super::*;

pub(crate) fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &crate::types::StateObservables,
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
    crate::scalar_metrics::apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = observables.per_object_scalars.clone();
    stats
}

/// Lightweight version of `make_step_stats` that uses only the `StepReport`
/// scalars and the current magnetization vector, avoiding a full
/// `observe_state` (which recomputes all fields including demag).
pub(crate) fn make_step_stats_from_report(
    step: u64,
    time: f64,
    report: &fullmag_engine::StepReport,
    wall_time_ns: u64,
    magnetization: &[[f64; 3]],
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: report.dt_used,
        e_ex: report.exchange_energy_joules,
        e_demag: report.demag_energy_joules,
        e_ext: report.external_energy_joules,
        e_ani: report.anisotropy_energy_joules,
        e_dmi: report.dmi_energy_joules,
        e_total: report.total_energy_joules,
        max_dm_dt: report.max_rhs_amplitude,
        max_rhs_norm_per_s: report.max_rhs_amplitude,
        max_h_eff: report.max_effective_field_amplitude,
        max_h_demag: report.max_demag_field_amplitude,
        max_torque_Apm: report.max_torque_Apm,
        max_torque_T: report.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    crate::scalar_metrics::apply_average_m_to_step_stats(&mut stats, magnetization);
    stats
}
