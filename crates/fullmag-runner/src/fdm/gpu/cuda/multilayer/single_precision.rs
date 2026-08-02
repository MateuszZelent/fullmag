use super::math::*;
use super::*;

pub(super) fn observe_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &[LayerStateSingle],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = if let Some(native_demag) = native_demag {
        native_demag.compute_demag_fields_f32(states)?
    } else {
        compute_demag_fields_single(contexts, states, demag_runtime)
    };
    let mut magnetization = Vec::new();
    let mut exchange_field = Vec::new();
    let mut demag_field = Vec::new();
    let mut external_field = Vec::new();
    let mut anisotropy_field = Vec::new();
    let mut dmi_field = Vec::new();
    let mut effective_field = Vec::new();
    let mut torque_field = Vec::new();
    let mut exchange_energy = 0.0;
    let mut demag_energy = 0.0;
    let mut external_energy = 0.0;
    let mut anisotropy_energy = 0.0;
    let mut dmi_energy = 0.0;
    let mut max_dm_dt: f64 = 0.0;
    let mut max_h_eff: f64 = 0.0;
    let mut max_h_demag: f64 = 0.0;
    let mut per_object_scalars: std::collections::HashMap<
        String,
        std::collections::HashMap<String, f64>,
    > = std::collections::HashMap::new();

    for ((index, context), gpu) in contexts.iter().enumerate().zip(gpu_contexts.iter_mut()) {
        let state = &states[index];
        let local_magnetization = to_f64_vectors(&state.magnetization);
        gpu.backend.upload_magnetization_f32(&state.magnetization)?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex_f32(gpu.cell_count)?;
        zero_outside_active_f32(&mut local_exchange, context.problem.active_mask.as_deref());
        let local_observables = observe_context_f32(context, &state.magnetization)?;
        let local_observable_exchange = to_f32_vectors(&local_observables.exchange_field);

        let mut local_demag = layer_demag.remove(0);
        zero_outside_active_f32(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_external = to_f32_vectors(&local_observables.external_field);
        let mut local_anisotropy = context.problem.anisotropy_field(&local_magnetization);
        let mut local_dmi = to_f32_vectors(&local_observables.dmi_field);
        zero_outside_active_f32(&mut local_external, context.problem.active_mask.as_deref());
        zero_outside_active(
            &mut local_anisotropy,
            context.problem.active_mask.as_deref(),
        );
        zero_outside_active_f32(&mut local_dmi, context.problem.active_mask.as_deref());
        let mut local_effective = to_f32_vectors(&local_observables.effective_field);
        for cell in 0..local_effective.len() {
            local_effective[cell] = add_f32(
                add_f32(local_effective[cell], local_demag[cell]),
                sub_f32(local_exchange[cell], local_observable_exchange[cell]),
            );
        }
        zero_outside_active_f32(&mut local_effective, context.problem.active_mask.as_deref());
        let rhs = llg_rhs_for_layer_f32(context, &state.magnetization, &local_effective);

        let layer_cell_volume = context.problem.cell_size.volume();
        let layer_ms = context.problem.material.saturation_magnetisation;
        let local_exchange_energy = local_observables.exchange_energy_joules;
        let local_demag_energy = field_energy_from_vectors_f32(
            &state.magnetization,
            &local_demag,
            -0.5 * MU0 * layer_ms * layer_cell_volume,
        );
        let local_external_energy = field_energy_from_vectors_f32(
            &state.magnetization,
            &local_external,
            -MU0 * layer_ms * layer_cell_volume,
        );
        let local_anisotropy_energy = local_observables.anisotropy_energy_joules;
        let local_dmi_energy = local_observables.dmi_energy_joules;
        exchange_energy += local_exchange_energy;
        demag_energy += local_demag_energy;
        external_energy += local_external_energy;
        anisotropy_energy += local_anisotropy_energy;
        dmi_energy += local_dmi_energy;
        max_dm_dt = max_dm_dt.max(max_norm_f32(&rhs));
        max_h_eff = max_h_eff.max(max_norm_f32(&local_effective));
        max_h_demag = max_h_demag.max(max_norm_f32(&local_demag));
        torque_field.extend(compute_torque_field(
            &local_magnetization,
            &to_f64_vectors(&local_effective),
            context.problem.material.damping,
            context.problem.dynamics.precession_enabled,
        ));

        let active_mask = context.problem.active_mask.as_deref();
        let [mx, my, mz] = crate::scalar_metrics::average_magnetization_components_with_active_mask(
            &local_magnetization,
            active_mask,
        );
        let m_weight = active_mask
            .map(|mask| mask.iter().filter(|active| **active).count())
            .unwrap_or_else(|| local_magnetization.len()) as f64
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

        magnetization.extend(local_magnetization);
        exchange_field.extend(to_f64_vectors(&local_exchange));
        demag_field.extend(to_f64_vectors(&local_demag));
        external_field.extend(to_f64_vectors(&local_external));
        anisotropy_field.extend(local_anisotropy);
        dmi_field.extend(to_f64_vectors(&local_dmi));
        effective_field.extend(to_f64_vectors(&local_effective));
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

pub(super) fn step_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &mut [LayerStateSingle],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
    mut native_demag: Option<&mut NativeMultilayerDemagOperator>,
    dt: f64,
) -> Result<(), RunError> {
    let m0 = states
        .iter()
        .map(|state| state.magnetization.clone())
        .collect::<Vec<_>>();
    let k1 = llg_rhs_multilayer_cuda_single(
        contexts,
        gpu_contexts,
        &m0,
        demag_runtime,
        native_demag.as_mut().map(|operator| &mut **operator),
    )?;
    let dt_f32 = dt as f32;
    let predicted = m0
        .iter()
        .zip(k1.iter())
        .map(|(layer_m, layer_k)| {
            layer_m
                .iter()
                .zip(layer_k.iter())
                .map(|(m, k)| normalized_f32(add_f32(*m, scale_f32(*k, dt_f32))))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;
    let k2 = llg_rhs_multilayer_cuda_single(
        contexts,
        gpu_contexts,
        &predicted,
        demag_runtime,
        native_demag.as_mut().map(|operator| &mut **operator),
    )?;
    let corrected = m0
        .iter()
        .zip(k1.iter().zip(k2.iter()))
        .map(|(layer_m, (layer_k1, layer_k2))| {
            layer_m
                .iter()
                .zip(layer_k1.iter().zip(layer_k2.iter()))
                .map(|(m, (rhs1, rhs2))| {
                    normalized_f32(add_f32(*m, scale_f32(add_f32(*rhs1, *rhs2), 0.5 * dt_f32)))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;

    for (state, new_layer) in states.iter_mut().zip(corrected.into_iter()) {
        state.magnetization = new_layer;
        state.time_seconds += dt;
    }
    Ok(())
}

pub(super) fn llg_rhs_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    magnetizations: &[Vec<[f32; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
) -> Result<Vec<Vec<[f32; 3]>>, RunError> {
    let mut layer_demag = if let Some(native_demag) = native_demag {
        let states = magnetizations
            .iter()
            .map(|magnetization| LayerStateSingle {
                magnetization: magnetization.clone(),
                time_seconds: 0.0,
            })
            .collect::<Vec<_>>();
        native_demag.compute_demag_fields_f32(&states)?
    } else {
        compute_demag_fields_single_from_m(contexts, magnetizations, demag_runtime)
    };
    let mut rhs_layers = Vec::with_capacity(contexts.len());
    for ((context, gpu), magnetization) in contexts
        .iter()
        .zip(gpu_contexts.iter_mut())
        .zip(magnetizations.iter())
    {
        gpu.backend.upload_magnetization_f32(magnetization)?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex_f32(gpu.cell_count)?;
        zero_outside_active_f32(&mut local_exchange, context.problem.active_mask.as_deref());
        let local_observables = observe_context_f32(context, magnetization)?;
        let local_observable_exchange = to_f32_vectors(&local_observables.exchange_field);
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active_f32(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_effective = to_f32_vectors(&local_observables.effective_field);
        for cell in 0..local_effective.len() {
            local_effective[cell] = add_f32(
                add_f32(local_effective[cell], local_demag[cell]),
                sub_f32(local_exchange[cell], local_observable_exchange[cell]),
            );
        }
        zero_outside_active_f32(&mut local_effective, context.problem.active_mask.as_deref());
        rhs_layers.push(llg_rhs_for_layer_f32(
            context,
            magnetization,
            &local_effective,
        ));
    }
    Ok(rhs_layers)
}

pub(super) fn compute_demag_fields_single(
    contexts: &[LayerContext],
    states: &[LayerStateSingle],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
) -> Vec<Vec<[f32; 3]>> {
    compute_demag_fields_single_from_m(
        contexts,
        &states
            .iter()
            .map(|state| state.magnetization.clone())
            .collect::<Vec<_>>(),
        demag_runtime,
    )
}

pub(super) fn compute_demag_fields_single_from_m(
    contexts: &[LayerContext],
    magnetizations: &[Vec<[f32; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
) -> Vec<Vec<[f32; 3]>> {
    let mut zero = contexts
        .iter()
        .map(|context| zero_vectors_f32(context.problem.grid.cell_count()))
        .collect::<Vec<_>>();
    let Some(runtime) = demag_runtime else {
        return zero;
    };

    let mut layers = contexts
        .iter()
        .zip(magnetizations.iter())
        .map(|(context, magnetization)| FdmLayerRuntimeF32 {
            magnet_name: context.magnet_name.clone(),
            grid: [
                context.problem.grid.nx,
                context.problem.grid.ny,
                context.problem.grid.nz,
            ],
            cell_size: [
                context.problem.cell_size.dx,
                context.problem.cell_size.dy,
                context.problem.cell_size.dz,
            ],
            origin: context.origin,
            ms: context.problem.material.saturation_magnetisation,
            exchange_stiffness: context.problem.material.exchange_stiffness,
            damping: context.problem.material.damping,
            active_mask: context.problem.active_mask.clone(),
            m: magnetization.clone(),
            h_ex: zero_vectors_f32(context.problem.grid.cell_count()),
            h_demag: zero_vectors_f32(context.problem.grid.cell_count()),
            h_eff: zero_vectors_f32(context.problem.grid.cell_count()),
            conv_grid: context.convolution_grid,
            conv_cell_size: context.convolution_cell_size,
            needs_transfer: context.needs_transfer,
        })
        .collect::<Vec<_>>();
    runtime.compute_demag_fields(&mut layers);
    for (index, layer) in layers.into_iter().enumerate() {
        zero[index] = layer.h_demag;
    }
    zero
}
