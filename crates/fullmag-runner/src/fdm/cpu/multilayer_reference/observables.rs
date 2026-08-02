//! CPU reference multilayer observable assembly.

use fullmag_engine::{multilayer::MultilayerDemagRuntime, ExchangeLlgState, MU0};

use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
use crate::types::{RunError, StateObservables};

use super::{
    add, compute_demag_fields, dot, llg_rhs_for_layer, max_norm, zero_outside_active, LayerContext,
};

pub(super) fn observe_multilayer(
    contexts: &[LayerContext],
    states: &[ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = compute_demag_fields(contexts, states, demag_runtime);
    let mut magnetization = Vec::new();
    let mut exchange_field = Vec::new();
    let mut demag_field = Vec::new();
    let mut external_field = Vec::new();
    let mut anisotropy_field = Vec::new();
    let mut dmi_field = Vec::new();
    let mut effective_field = Vec::new();
    let mut exchange_energy = 0.0;
    let mut demag_energy = 0.0;
    let mut external_energy = 0.0;
    let mut anisotropy_energy = 0.0;
    let mut dmi_energy = 0.0;
    let mut max_dm_dt: f64 = 0.0;
    let mut max_h_eff: f64 = 0.0;
    let mut max_h_demag: f64 = 0.0;
    let mut torque_field = Vec::new();
    let mut per_object_scalars: std::collections::HashMap<
        String,
        std::collections::HashMap<String, f64>,
    > = std::collections::HashMap::new();

    for (index, context) in contexts.iter().enumerate() {
        let state = &states[index];
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        let local_observables = context.problem.observe(state).map_err(|error| RunError {
            message: format!(
                "local observables for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;
        let local_exchange = local_observables.exchange_field;
        let mut local_external = local_observables.external_field;
        let mut local_anisotropy = context.problem.anisotropy_field(state.magnetization());
        let mut local_dmi = local_observables.dmi_field;
        zero_outside_active(&mut local_external, context.problem.active_mask.as_deref());
        zero_outside_active(
            &mut local_anisotropy,
            context.problem.active_mask.as_deref(),
        );
        zero_outside_active(&mut local_dmi, context.problem.active_mask.as_deref());
        let mut local_effective = local_observables.effective_field;
        for cell in 0..local_effective.len() {
            local_effective[cell] = add(local_effective[cell], local_demag[cell]);
        }
        zero_outside_active(&mut local_effective, context.problem.active_mask.as_deref());
        let rhs = llg_rhs_for_layer(context, state.magnetization(), &local_effective);

        let layer_cell_volume = context.problem.cell_size.volume();
        let layer_ms = context.problem.material.saturation_magnetisation;
        let local_exchange_energy = local_observables.exchange_energy_joules;
        let local_demag_energy = state
            .magnetization()
            .iter()
            .zip(local_demag.iter())
            .map(|(m, h)| -0.5 * MU0 * layer_ms * dot(*m, *h) * layer_cell_volume)
            .sum::<f64>();
        let local_external_energy = state
            .magnetization()
            .iter()
            .zip(local_external.iter())
            .map(|(m, h)| -MU0 * layer_ms * dot(*m, *h) * layer_cell_volume)
            .sum::<f64>();
        let local_anisotropy_energy = local_observables.anisotropy_energy_joules;
        let local_dmi_energy = local_observables.dmi_energy_joules;
        exchange_energy += local_exchange_energy;
        demag_energy += local_demag_energy;
        external_energy += local_external_energy;
        anisotropy_energy += local_anisotropy_energy;
        dmi_energy += local_dmi_energy;
        max_dm_dt = max_dm_dt.max(max_norm(&rhs));
        max_h_eff = max_h_eff.max(max_norm(&local_effective));
        max_h_demag = max_h_demag.max(max_norm(&local_demag));
        torque_field.extend(compute_torque_field(
            state.magnetization(),
            &local_effective,
            context.problem.material.damping,
            context.problem.dynamics.precession_enabled,
        ));

        let active_mask = context.problem.active_mask.as_deref();
        let [mx, my, mz] = crate::scalar_metrics::average_magnetization_components_with_active_mask(
            state.magnetization(),
            active_mask,
        );
        let m_weight = active_mask
            .map(|mask| mask.iter().filter(|active| **active).count())
            .unwrap_or_else(|| state.magnetization().len()) as f64
            * context.problem.cell_size.volume()
            * context.problem.material.saturation_magnetisation;
        per_object_scalars.insert(
            context.magnet_name.clone(),
            std::collections::HashMap::from([
                ("e_ex".to_string(), local_exchange_energy),
                ("e_demag".to_string(), local_demag_energy),
                ("e_ext".to_string(), local_external_energy),
                ("e_ani".to_string(), local_anisotropy_energy),
                ("e_dmi".to_string(), local_dmi_energy),
                (
                    "e_total".to_string(),
                    local_exchange_energy
                        + local_demag_energy
                        + local_external_energy
                        + local_anisotropy_energy
                        + local_dmi_energy,
                ),
                ("mx".to_string(), mx),
                ("my".to_string(), my),
                ("mz".to_string(), mz),
                ("m_weight".to_string(), m_weight),
            ]),
        );

        magnetization.extend_from_slice(state.magnetization());
        exchange_field.extend(local_exchange);
        demag_field.extend(local_demag);
        external_field.extend(local_external);
        anisotropy_field.extend(local_anisotropy);
        dmi_field.extend(local_dmi);
        effective_field.extend(local_effective);
    }

    for values in per_object_scalars.values_mut() {
        values.insert("max_dm_dt".to_string(), max_dm_dt);
        values.insert("max_h_eff".to_string(), max_h_eff);
        values.insert("max_h_demag".to_string(), max_h_demag);
    }

    let max_torque_apm = max_torque_residual_apm_from_field(&magnetization, &effective_field);

    Ok(StateObservables {
        magnetization,
        torque_field,
        exchange_field,
        demag_field,
        external_field,
        antenna_field: vec![[0.0, 0.0, 0.0]; effective_field.len()],
        effective_field,
        anisotropy_field,
        dmi_field,
        magnetoelastic_field: Vec::new(),
        cubic_anisotropy_field: Vec::new(),
        bulk_dmi_field: Vec::new(),
        oersted_field: Vec::new(),
        thermal_field: Vec::new(),
        exchange_energy,
        demag_energy,
        external_energy,
        anisotropy_energy,
        dmi_energy,
        total_energy: exchange_energy
            + demag_energy
            + external_energy
            + anisotropy_energy
            + dmi_energy,
        max_dm_dt,
        max_h_eff,
        max_h_demag,
        max_torque_Apm: max_torque_apm,
        per_object_scalars,
    })
}
