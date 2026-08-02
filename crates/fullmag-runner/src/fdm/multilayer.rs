//! Shared FDM multilayer runner helpers.

use crate::scalar_metrics::weighted_average_m_from_object_scalars;
use crate::types::{StateObservables, StepStats};
use fullmag_ir::IntegratorChoice;

pub(crate) type MultilayerVectorState = Vec<Vec<[f64; 3]>>;

pub(crate) fn explicit_rk_step<F>(
    initial: &MultilayerVectorState,
    dt: f64,
    integrator: IntegratorChoice,
    mut rhs: F,
) -> Result<MultilayerVectorState, String>
where
    F: FnMut(&MultilayerVectorState) -> Result<MultilayerVectorState, String>,
{
    let k1 = rhs(initial)?;
    match integrator {
        IntegratorChoice::Heun => {
            let y2 = combine_normalized(initial, &[(&k1, dt)])?;
            let k2 = rhs(&y2)?;
            combine_normalized(initial, &[(&k1, 0.5 * dt), (&k2, 0.5 * dt)])
        }
        IntegratorChoice::Rk4 => {
            let y2 = combine_normalized(initial, &[(&k1, 0.5 * dt)])?;
            let k2 = rhs(&y2)?;
            let y3 = combine_normalized(initial, &[(&k2, 0.5 * dt)])?;
            let k3 = rhs(&y3)?;
            let y4 = combine_normalized(initial, &[(&k3, dt)])?;
            let k4 = rhs(&y4)?;
            combine_normalized(
                initial,
                &[
                    (&k1, dt / 6.0),
                    (&k2, dt / 3.0),
                    (&k3, dt / 3.0),
                    (&k4, dt / 6.0),
                ],
            )
        }
        IntegratorChoice::Rk23 => {
            let y2 = combine_normalized(initial, &[(&k1, 0.5 * dt)])?;
            let k2 = rhs(&y2)?;
            let y3 = combine_normalized(initial, &[(&k2, 0.75 * dt)])?;
            let k3 = rhs(&y3)?;
            combine_normalized(
                initial,
                &[
                    (&k1, 2.0 * dt / 9.0),
                    (&k2, dt / 3.0),
                    (&k3, 4.0 * dt / 9.0),
                ],
            )
        }
        unsupported => Err(format!(
            "staged multilayer explicit RK does not implement {unsupported:?}"
        )),
    }
}

fn combine_normalized(
    initial: &MultilayerVectorState,
    increments: &[(&MultilayerVectorState, f64)],
) -> Result<MultilayerVectorState, String> {
    initial
        .iter()
        .enumerate()
        .map(|(layer_index, layer)| {
            layer
                .iter()
                .enumerate()
                .map(|(cell_index, m)| {
                    let mut value = *m;
                    for (stage, coefficient) in increments {
                        for component in 0..3 {
                            value[component] +=
                                coefficient * stage[layer_index][cell_index][component];
                        }
                    }
                    let norm = value
                        .iter()
                        .map(|component| component * component)
                        .sum::<f64>()
                        .sqrt();
                    if !norm.is_finite() || norm == 0.0 {
                        return Err(
                            "explicit RK stage produced a non-normalizable magnetization"
                                .to_string(),
                        );
                    }
                    Ok([value[0] / norm, value[1] / norm, value[2] / norm])
                })
                .collect()
        })
        .collect()
}

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

#[cfg(test)]
mod tests {
    use super::{explicit_rk_step, make_multilayer_step_stats, MultilayerVectorState};
    use crate::types::StateObservables;
    use fullmag_ir::IntegratorChoice;

    fn manufactured_rhs(state: &MultilayerVectorState) -> Result<MultilayerVectorState, String> {
        Ok(state
            .iter()
            .map(|layer| {
                layer
                    .iter()
                    .map(|m| [m[1] + 0.25 * m[0], -0.5 * m[0] + m[2], m[0] - 0.2 * m[2]])
                    .collect()
            })
            .collect())
    }

    fn assert_vector_close(actual: [f64; 3], expected: [f64; 3]) {
        for component in 0..3 {
            assert!((actual[component] - expected[component]).abs() < 1.0e-8);
        }
    }

    #[test]
    fn multilayer_heun_executes_heun_tableau() {
        let initial = vec![vec![[1.0, 0.0, 0.0]]];
        let actual =
            explicit_rk_step(&initial, 0.2, IntegratorChoice::Heun, manufactured_rhs).unwrap();
        assert_vector_close(actual[0][0], [0.98021667, -0.07564913, 0.18290020]);
    }

    #[test]
    fn multilayer_rk4_executes_rk4_tableau() {
        let initial = vec![vec![[1.0, 0.0, 0.0]]];
        let heun =
            explicit_rk_step(&initial, 0.2, IntegratorChoice::Heun, manufactured_rhs).unwrap();
        let rk4 = explicit_rk_step(&initial, 0.2, IntegratorChoice::Rk4, manufactured_rhs).unwrap();
        assert_ne!(rk4, heun, "RK4 must not route through the Heun tableau");
        assert_vector_close(rk4[0][0], [0.98012969, -0.07565319, 0.18336407]);
    }

    #[test]
    fn multilayer_rk23_executes_bogacki_shampine_tableau() {
        let initial = vec![vec![[1.0, 0.0, 0.0]]];
        let heun =
            explicit_rk_step(&initial, 0.2, IntegratorChoice::Heun, manufactured_rhs).unwrap();
        let rk23 =
            explicit_rk_step(&initial, 0.2, IntegratorChoice::Rk23, manufactured_rhs).unwrap();
        assert_ne!(rk23, heun, "RK23 must not route through the Heun tableau");
        assert_vector_close(rk23[0][0], [0.98013383, -0.07563269, 0.18335039]);
    }

    #[test]
    fn multilayer_stats_keep_exact_torque_separate_from_rhs_norm() {
        let observables = StateObservables {
            magnetization: vec![[1.0, 0.0, 0.0]],
            torque_field: Vec::new(),
            exchange_field: Vec::new(),
            demag_field: Vec::new(),
            external_field: Vec::new(),
            antenna_field: Vec::new(),
            drive_field: Vec::new(),
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
            drive_energy: 0.0,
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
