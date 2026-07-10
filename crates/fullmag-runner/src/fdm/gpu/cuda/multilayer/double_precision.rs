use super::math::*;
use super::*;

pub(super) fn execute_cuda_assisted_multilayer_double(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
    pure_damping_relax: bool,
    contexts: Vec<LayerContext>,
    mut states: Vec<ExchangeLlgState>,
    mut gpu_contexts: Vec<LayerGpuContext>,
    demag_runtime: Option<MultilayerDemagRuntime>,
    mut native_demag: Option<NativeMultilayerDemagOperator>,
) -> Result<ExecutedRun, RunError> {
    let device_info = gpu_contexts
        .first()
        .and_then(|gpu| gpu.backend.device_info().ok());

    let initial_magnetization = flatten_layers(
        &states
            .iter()
            .map(|state| state.magnetization().to_vec())
            .collect::<Vec<_>>(),
    );
    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut step_count = 0u64;
    let native_demag_enabled = native_demag.is_some();
    let provenance =
        assisted_multilayer_provenance(plan, device_info.clone(), native_demag_enabled);
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    let initial_observables = observe_multilayer_cuda(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
        native_demag.as_mut(),
    )?;
    if default_scalar_trace {
        let stats = make_step_stats(0, 0.0, 0.0, 0, &initial_observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
    }
    record_due_fields(
        &initial_observables,
        0,
        0.0,
        0.0,
        &mut field_schedules,
        &mut artifacts,
    )?;

    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut cancelled = false;
    let mut paused = false;
    while current_time(&states) < until_seconds {
        let dt_step = dt.min(until_seconds - current_time(&states));
        let wall_start = Instant::now();
        step_multilayer_cuda(
            &contexts,
            &mut gpu_contexts,
            &mut states,
            demag_runtime.as_ref(),
            native_demag.as_mut(),
            dt_step,
        )?;
        let wall_time_ns = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        let observables = observe_multilayer_cuda(
            &contexts,
            &mut gpu_contexts,
            &states,
            demag_runtime.as_ref(),
            native_demag.as_mut(),
        )?;
        let latest_stats = make_step_stats(
            step_count,
            current_time(&states),
            dt_step,
            wall_time_ns,
            &observables,
        );

        if default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|schedule| is_due(latest_stats.time, schedule.next_time))
        {
            artifacts.record_scalar(&latest_stats)?;
            steps.push(latest_stats.clone());
            advance_due_schedules(&mut scalar_schedules, latest_stats.time);
        }

        record_due_fields(
            &observables,
            latest_stats.step,
            latest_stats.time,
            latest_stats.dt,
            &mut field_schedules,
            &mut artifacts,
        )?;

        if let Some((grid, on_step)) = live.as_mut() {
            let action = on_step(StepUpdate {
                stats: latest_stats.clone(),
                grid: [grid[0], grid[1], grid[2]],
                fem_mesh: None,
                magnetization: None,
                preview_field: None,
                cached_preview_fields: None,
                scalar_row_due: false,
                finished: false,
            });
            match action {
                StepAction::Continue => {}
                StepAction::Stop => {
                    cancelled = true;
                }
                StepAction::Pause => {
                    paused = true;
                }
            }
        }

        if cancelled || paused {
            break;
        }

        let energy_plateau_range = energy_plateau.record(latest_stats.e_total);
        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            latest_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                || relaxation_converged(
                    control,
                    &latest_stats,
                    energy_plateau_range,
                    plan.gyromagnetic_ratio,
                    average_damping(&contexts),
                    pure_damping_relax,
                )
        });
        if stop_for_relaxation {
            break;
        }
    }

    let final_observables = observe_multilayer_cuda(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
        native_demag.as_mut(),
    )?;
    let final_stats = make_step_stats(
        step_count,
        current_time(&states),
        dt.min(until_seconds.max(dt)),
        0,
        &final_observables,
    );
    if !steps
        .iter()
        .any(|step| step.step == final_stats.step && (step.time - final_stats.time).abs() <= 1e-18)
    {
        artifacts.record_scalar(&final_stats)?;
        steps.push(final_stats.clone());
    }
    for schedule in &mut field_schedules {
        if schedule
            .last_sampled_time
            .map(|time| same_time(time, final_stats.time))
            .unwrap_or(false)
        {
            continue;
        }
        let values = select_state_observable_field(&final_observables, &schedule.name, false)?;
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        })?;
    }

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let status = if paused {
        RunStatus::Paused
    } else if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::resolve_stage_completion(
        status,
        plan.relaxation.as_ref(),
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: None,
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: step_count,
            relaxation_time_s: Some(latest_stats.time),
            numerical_stagnation: false,
        },
    );

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization: flatten_layers(
                &states
                    .iter()
                    .map(|state| state.magnetization().to_vec())
                    .collect::<Vec<_>>(),
            ),
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn observe_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &[ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = if let Some(native_demag) = native_demag {
        native_demag.compute_demag_fields(states)?
    } else {
        compute_demag_fields(contexts, states, demag_runtime)
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
        gpu.backend.upload_magnetization(state.magnetization())?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex(gpu.cell_count)?;
        zero_outside_active(&mut local_exchange, context.problem.active_mask.as_deref());
        let local_observables = context.problem.observe(state).map_err(|error| RunError {
            message: format!(
                "local observables for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;

        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
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
            local_effective[cell] = add(
                add(local_effective[cell], local_demag[cell]),
                sub(local_exchange[cell], local_observables.exchange_field[cell]),
            );
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

        let [mx, my, mz] =
            crate::scalar_metrics::average_magnetization_components(state.magnetization());
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

fn step_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &mut [ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
    mut native_demag: Option<&mut NativeMultilayerDemagOperator>,
    dt: f64,
) -> Result<(), RunError> {
    let m0 = states
        .iter()
        .map(|state| state.magnetization().to_vec())
        .collect::<Vec<_>>();
    let k1 = llg_rhs_multilayer_cuda(
        contexts,
        gpu_contexts,
        &m0,
        demag_runtime,
        native_demag.as_mut().map(|operator| &mut **operator),
    )?;
    let predicted = m0
        .iter()
        .zip(k1.iter())
        .map(|(layer_m, layer_k)| {
            layer_m
                .iter()
                .zip(layer_k.iter())
                .map(|(m, k)| normalized(add(*m, scale(*k, dt))))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;
    let k2 = llg_rhs_multilayer_cuda(
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
                .map(|(m, (rhs1, rhs2))| normalized(add(*m, scale(add(*rhs1, *rhs2), 0.5 * dt))))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;

    for (state, new_layer) in states.iter_mut().zip(corrected.into_iter()) {
        state
            .set_magnetization(new_layer)
            .map_err(|error| RunError {
                message: format!("setting multilayer magnetization: {}", error),
            })?;
        state.time_seconds += dt;
    }
    Ok(())
}

fn llg_rhs_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    magnetizations: &[Vec<[f64; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntime>,
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
) -> Result<Vec<Vec<[f64; 3]>>, RunError> {
    let mut states = Vec::with_capacity(contexts.len());
    for (context, magnetization) in contexts.iter().zip(magnetizations.iter()) {
        states.push(
            context
                .problem
                .new_state(magnetization.clone())
                .map_err(|error| RunError {
                    message: format!(
                        "temporary multilayer state for magnet '{}': {}",
                        context.magnet_name, error
                    ),
                })?,
        );
    }
    let mut layer_demag = if let Some(native_demag) = native_demag {
        native_demag.compute_demag_fields(&states)?
    } else {
        compute_demag_fields(contexts, &states, demag_runtime)
    };
    let mut rhs_layers = Vec::with_capacity(contexts.len());
    for ((context, gpu), state) in contexts
        .iter()
        .zip(gpu_contexts.iter_mut())
        .zip(states.iter())
    {
        gpu.backend.upload_magnetization(state.magnetization())?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex(gpu.cell_count)?;
        zero_outside_active(&mut local_exchange, context.problem.active_mask.as_deref());
        let local_observables = context.problem.observe(state).map_err(|error| RunError {
            message: format!(
                "local observables for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_effective = local_observables.effective_field;
        for cell in 0..local_effective.len() {
            local_effective[cell] = add(
                add(local_effective[cell], local_demag[cell]),
                sub(local_exchange[cell], local_observables.exchange_field[cell]),
            );
        }
        zero_outside_active(&mut local_effective, context.problem.active_mask.as_deref());
        rhs_layers.push(llg_rhs_for_layer(
            context,
            state.magnetization(),
            &local_effective,
        ));
    }
    Ok(rhs_layers)
}

fn compute_demag_fields(
    contexts: &[LayerContext],
    states: &[ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
) -> Vec<Vec<[f64; 3]>> {
    let mut zero = contexts
        .iter()
        .map(|context| zero_vectors(context.problem.grid.cell_count()))
        .collect::<Vec<_>>();
    let Some(runtime) = demag_runtime else {
        return zero;
    };

    let mut layers = contexts
        .iter()
        .zip(states.iter())
        .map(|(context, state)| FdmLayerRuntime {
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
            m: state.magnetization().to_vec(),
            h_ex: zero_vectors(context.problem.grid.cell_count()),
            h_demag: zero_vectors(context.problem.grid.cell_count()),
            h_eff: zero_vectors(context.problem.grid.cell_count()),
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
