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
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = observables.per_object_scalars.clone();
    stats
}

#[cfg(test)]
mod tests {
    use super::make_multilayer_step_stats;
    use crate::types::StateObservables;

    #[test]
    fn multilayer_stats_keep_exact_torque_separate_from_rhs_norm() {
        let observables = StateObservables {
            magnetization: vec![[1.0, 0.0, 0.0]],
            torque_field: Vec::new(),
            exchange_field: Vec::new(),
            demag_field: Vec::new(),
            external_field: Vec::new(),
            antenna_field: Vec::new(),
            effective_field: Vec::new(),
            anisotropy_field: Vec::new(),
            dmi_field: Vec::new(),
            magnetoelastic_field: Vec::new(),
            cubic_anisotropy_field: Vec::new(),
            bulk_dmi_field: Vec::new(),
            oersted_field: Vec::new(),
            thermal_field: Vec::new(),
            exchange_energy: 0.0,
            demag_energy: 0.0,
            external_energy: 0.0,
            anisotropy_energy: 0.0,
            dmi_energy: 0.0,
            total_energy: 0.0,
            max_dm_dt: 13.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            per_object_scalars: std::collections::HashMap::new(),
        };

        let stats = make_multilayer_step_stats(1, 2.0, 0.1, 3, &observables);

        assert_eq!(stats.max_torque_Apm, 0.0);
        assert_eq!(stats.max_torque_T, 0.0);
        assert_eq!(stats.max_rhs_norm_per_s, 13.0);
    }
}
