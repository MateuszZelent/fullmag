use super::math::*;
use super::*;

#[derive(Debug, Clone)]
pub(super) struct NativeStackedLayer {
    magnet_name: String,
    native_grid: [usize; 3],
    offset: [usize; 3],
    context: LayerContext,
}

pub(super) struct NativeStackedCudaPlan {
    pub(super) combined_plan: FdmPlanIR,
    pub(super) layers: Vec<NativeStackedLayer>,
    pub(super) global_grid: [u32; 3],
}

pub(super) fn build_native_stacked_cuda_plan(
    plan: &FdmMultilayerPlanIR,
) -> Result<Option<NativeStackedCudaPlan>, RunError> {
    let Some(first_layer) = plan.layers.first() else {
        return Ok(None);
    };

    let reference_material = &first_layer.material;
    let reference_cell_size = first_layer.native_cell_size;
    if plan.layers.iter().any(|layer| {
        layer.material != *reference_material || layer.native_cell_size != reference_cell_size
    }) {
        return Ok(None);
    }
    let (layer_contexts, _) = build_contexts_and_states(plan, false)?;

    let mut min_origin = first_layer.native_origin;
    let mut max_extent = [
        first_layer.native_origin[0] + first_layer.native_grid[0] as f64 * reference_cell_size[0],
        first_layer.native_origin[1] + first_layer.native_grid[1] as f64 * reference_cell_size[1],
        first_layer.native_origin[2] + first_layer.native_grid[2] as f64 * reference_cell_size[2],
    ];
    for layer in plan.layers.iter().skip(1) {
        for axis in 0..3 {
            min_origin[axis] = min_origin[axis].min(layer.native_origin[axis]);
            max_extent[axis] = max_extent[axis].max(
                layer.native_origin[axis]
                    + layer.native_grid[axis] as f64 * reference_cell_size[axis],
            );
        }
    }

    let mut global_grid = [0u32; 3];
    for axis in 0..3 {
        let cells = (max_extent[axis] - min_origin[axis]) / reference_cell_size[axis];
        let rounded = cells.round();
        if (cells - rounded).abs() > 1e-6 || rounded < 1.0 {
            return Ok(None);
        }
        global_grid[axis] = rounded as u32;
    }

    let global_grid_usize = [
        global_grid[0] as usize,
        global_grid[1] as usize,
        global_grid[2] as usize,
    ];
    let total_cells = fullmag_plan::checked_fdm_grid_cost(
        global_grid,
        fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    )
    .map_err(|error| RunError {
        message: format!("native stacked global grid budget rejected before allocation: {error}"),
    })
    .and_then(|cost| {
        usize::try_from(cost.cells).map_err(|_| RunError {
            message: format!(
                "native stacked global grid cell count {} is not addressable",
                cost.cells
            ),
        })
    })?;
    let mut active_mask = vec![false; total_cells];
    let mut region_mask = vec![0u32; total_cells];
    let mut initial_magnetization = vec![[0.0, 0.0, 0.0]; total_cells];
    let mut layers = Vec::with_capacity(plan.layers.len());

    for (layer_index, layer) in plan.layers.iter().enumerate() {
        let native_grid = [
            layer.native_grid[0] as usize,
            layer.native_grid[1] as usize,
            layer.native_grid[2] as usize,
        ];
        let mut offset = [0usize; 3];
        for axis in 0..3 {
            let offset_cells =
                (layer.native_origin[axis] - min_origin[axis]) / reference_cell_size[axis];
            let rounded = offset_cells.round();
            if (offset_cells - rounded).abs() > 1e-6 || rounded < 0.0 {
                return Ok(None);
            }
            offset[axis] = rounded as usize;
        }

        for z in 0..native_grid[2] {
            for y in 0..native_grid[1] {
                for x in 0..native_grid[0] {
                    let local_index = z * native_grid[1] * native_grid[0] + y * native_grid[0] + x;
                    let is_active = layer
                        .native_active_mask
                        .as_ref()
                        .map_or(true, |mask| mask[local_index]);
                    if !is_active {
                        continue;
                    }

                    let gx = offset[0] + x;
                    let gy = offset[1] + y;
                    let gz = offset[2] + z;
                    if gx >= global_grid_usize[0]
                        || gy >= global_grid_usize[1]
                        || gz >= global_grid_usize[2]
                    {
                        return Ok(None);
                    }
                    let global_index = gz * global_grid_usize[1] * global_grid_usize[0]
                        + gy * global_grid_usize[0]
                        + gx;
                    if active_mask[global_index] {
                        return Err(RunError {
                            message: format!(
                                "native single-grid multilayer CUDA fast path encountered overlapping active cells between bodies near global cell ({gx}, {gy}, {gz})"
                            ),
                        });
                    }
                    active_mask[global_index] = true;
                    region_mask[global_index] = (layer_index + 1) as u32;
                    initial_magnetization[global_index] = layer.initial_magnetization[local_index];
                }
            }
        }

        layers.push(NativeStackedLayer {
            magnet_name: layer.magnet_name.clone(),
            native_grid,
            offset,
            context: layer_contexts[layer_index].clone(),
        });
    }

    Ok(Some(NativeStackedCudaPlan {
        combined_plan: FdmPlanIR {
            grid: GridDimensions { cells: global_grid },
            cell_size: reference_cell_size,
            region_mask,
            active_mask: Some(active_mask),
            initial_magnetization,
            material: reference_material.clone(),
            enable_exchange: plan.enable_exchange,
            enable_demag: plan.enable_demag,
            external_field: plan.external_field,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
            precision: plan.precision,
            exchange_bc: plan.exchange_bc,
            periodicity: plan.periodicity.clone(),
            integrator: plan.integrator,
            fixed_timestep: plan.fixed_timestep,
            adaptive_timestep: None,
            field_refresh: plan.field_refresh.clone(),
            relaxation: plan.relaxation.clone(),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            boundary_geometry: None,
            inter_region_exchange: vec![],
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            temperature: None,
            interfacial_dmi: plan.interfacial_dmi,
            bulk_dmi: plan.bulk_dmi,
            mel_b1: None,
            mel_b2: None,
            mel_uniform_strain: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
        },
        layers,
        global_grid,
    }))
}

pub(super) fn execute_native_stacked_cuda_multilayer(
    plan: &FdmMultilayerPlanIR,
    native: &NativeStackedCudaPlan,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    let mut backend = NativeFdmBackend::create(&native.combined_plan)?;
    let device_info = backend.device_info().ok();
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
    let mut steps: Vec<StepStats> = Vec::new();
    let timestep_policy = crate::resolve_timestep_policy(
        native.combined_plan.integrator,
        native.combined_plan.fixed_timestep,
        native.combined_plan.adaptive_timestep.as_ref(),
        crate::types::TimestepExecutionLane::fdm_cuda(native.combined_plan.precision),
    )?;
    let provenance = ExecutionProvenance {
        execution_engine: "cuda_native_multilayer_single_grid".to_string(),
        precision: precision_name(native.combined_plan.precision).to_string(),
        demag_operator_kind: if native.combined_plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: if native.combined_plan.enable_demag {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: device_info.as_ref().map(|info| info.name.clone()),
        compute_capability: device_info
            .as_ref()
            .map(|info| info.compute_capability.clone()),
        cuda_driver_version: device_info.as_ref().map(|info| info.driver_version),
        cuda_runtime_version: device_info.as_ref().map(|info| info.runtime_version),
        timestep_policy: Some(timestep_policy.clone()),
        ..Default::default()
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();
    let mut dt = timestep_policy.initial_dt();
    let initial_magnetization = flatten_layers(
        &plan
            .layers
            .iter()
            .map(|layer| layer.initial_magnetization.clone())
            .collect::<Vec<_>>(),
    );

    let initial_observables = observe_native_stacked_cuda(&backend, native)?;
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
    let mut torque_confirmation = crate::relaxation::RelaxationTorqueConfirmation::default();
    let mut latest_stats: Option<StepStats> = None;
    let mut cancelled = false;
    let mut paused = false;
    while latest_stats.as_ref().map_or(0.0, |stats| stats.time) < until_seconds {
        let current_time = latest_stats.as_ref().map_or(0.0, |stats| stats.time);
        let dt_step = dt.min(until_seconds - current_time);
        let native_stats = backend.step(dt_step)?;
        if let Some(next) = native_stats.dt_suggested {
            dt = next;
        }
        let need_observables = default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|schedule| is_due(native_stats.time, schedule.next_time))
            || field_schedules
                .iter()
                .any(|schedule| is_due(native_stats.time, schedule.next_time))
            || live.is_some()
            || plan.relaxation.is_some();
        let observables = if need_observables {
            Some(observe_native_stacked_cuda(&backend, native)?)
        } else {
            None
        };
        let stats = observables
            .as_ref()
            .map(|observables| make_native_stacked_step_stats(&native_stats, observables))
            .unwrap_or(native_stats);

        if default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|schedule| is_due(stats.time, schedule.next_time))
        {
            artifacts.record_scalar(&stats)?;
            steps.push(stats.clone());
            advance_due_schedules(&mut scalar_schedules, stats.time);
        }

        if let Some(observables) = observables.as_ref() {
            record_due_fields(
                observables,
                stats.step,
                stats.time,
                stats.dt,
                &mut field_schedules,
                &mut artifacts,
            )?;
            if let Some((_, on_step)) = live.as_mut() {
                let action = on_step(StepUpdate {
                    coupled_checkpoint: None,
                    stats: stats.clone(),
                    grid: native.global_grid,
                    fem_mesh_generation_id: None,
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
        } else if let Some((_, on_step)) = live.as_mut() {
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: stats.clone(),
                grid: native.global_grid,
                fem_mesh_generation_id: None,
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

        let energy_plateau_range = energy_plateau.record(stats.e_total);
        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                || torque_confirmation.observe_stats(
                    control,
                    &stats,
                    energy_plateau_range,
                    plan.gyromagnetic_ratio,
                    native.combined_plan.material.damping,
                    pure_damping_relax,
                )
        });
        latest_stats = Some(stats);
        if stop_for_relaxation {
            break;
        }
    }

    let final_observables = observe_native_stacked_cuda(&backend, native)?;
    let final_stats =
        latest_stats.unwrap_or_else(|| make_step_stats(0, 0.0, 0.0, 0, &final_observables));
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
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: (final_stats.step as u64).saturating_add(1),
            values: FieldSnapshot::flatten_vec3(select_state_observable_field(
                &final_observables,
                &schedule.name,
                false,
            )?),
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
            max_torque_apm: Some(stats.max_torque_Apm),
            torque_confirmed: torque_confirmation.confirmed(),
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: stats.step,
            relaxation_time_s: Some(stats.time),
            numerical_stagnation: false,
        },
    );

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization: final_observables.magnetization.clone(),
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

pub(super) fn make_native_stacked_step_stats(
    native_step: &StepStats,
    observables: &StateObservables,
) -> StepStats {
    let mut stats = make_step_stats(
        native_step.step,
        native_step.time,
        native_step.dt,
        native_step.wall_time_ns,
        observables,
    );
    stats.dt_suggested = native_step.dt_suggested;
    stats
}

pub(super) fn single_layer_cuda_plan(
    plan: &FdmMultilayerPlanIR,
    layer: &FdmLayerPlanIR,
) -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions {
            cells: layer.native_grid,
        },
        cell_size: layer.native_cell_size,
        region_mask: vec![0; layer.initial_magnetization.len()],
        active_mask: layer.native_active_mask.clone(),
        initial_magnetization: layer.initial_magnetization.clone(),
        material: FdmMaterialIR {
            name: layer.material.name.clone(),
            saturation_magnetisation: layer.material.saturation_magnetisation,
            exchange_stiffness: layer.material.exchange_stiffness,
            damping: layer.material.damping,
            uniaxial_anisotropy_ku1: layer.material.uniaxial_anisotropy_ku1,
            uniaxial_anisotropy_ku2: layer.material.uniaxial_anisotropy_ku2,
            anisotropy_axis: layer.material.anisotropy_axis,
            cubic_anisotropy_kc1: layer.material.cubic_anisotropy_kc1,
            cubic_anisotropy_kc2: layer.material.cubic_anisotropy_kc2,
            cubic_anisotropy_kc3: layer.material.cubic_anisotropy_kc3,
            cubic_anisotropy_axis1: layer.material.cubic_anisotropy_axis1,
            cubic_anisotropy_axis2: layer.material.cubic_anisotropy_axis2,
            ..Default::default()
        },
        enable_exchange: plan.enable_exchange,
        enable_demag: false,
        external_field: plan.external_field,
        gyromagnetic_ratio: plan.gyromagnetic_ratio,
        precision: plan.precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: None,
        integrator: plan.integrator,
        fixed_timestep: plan.fixed_timestep,
        adaptive_timestep: None,
        field_refresh: plan.field_refresh.clone(),
        relaxation: None,
        boundary_correction: None,
        boundary_phi_floor: None,
        boundary_delta_min: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
        sot_current_density: None,
        sot_xi_dl: None,
        sot_xi_fl: None,
        sot_sigma: None,
        sot_thickness: None,
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        temperature: None,
        interfacial_dmi: plan.interfacial_dmi,
        bulk_dmi: plan.bulk_dmi,
        mel_b1: None,
        mel_b2: None,
        mel_uniform_strain: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        oersted_realization: None,
    }
}

pub(super) fn observe_native_stacked_cuda(
    backend: &NativeFdmBackend,
    native: &NativeStackedCudaPlan,
) -> Result<StateObservables, RunError> {
    let cell_count = native.combined_plan.initial_magnetization.len();
    let magnetization_full = backend.copy_m(cell_count)?;
    let exchange_full = backend.copy_h_ex(cell_count)?;
    let demag_full = backend.copy_h_demag(cell_count)?;
    let external_full = backend.copy_h_ext(cell_count)?;
    let effective_full = backend.copy_h_eff(cell_count)?;
    observe_native_stacked_fields(
        native,
        &magnetization_full,
        &exchange_full,
        &demag_full,
        &external_full,
        &effective_full,
    )
}

pub(super) fn observe_native_stacked_fields(
    native: &NativeStackedCudaPlan,
    magnetization_full: &[[f64; 3]],
    exchange_full: &[[f64; 3]],
    demag_full: &[[f64; 3]],
    external_full: &[[f64; 3]],
    effective_full: &[[f64; 3]],
) -> Result<StateObservables, RunError> {
    let cell_count = magnetization_full.len();
    let active_mask = native.combined_plan.active_mask.as_deref();
    let cell_volume = native.combined_plan.cell_size[0]
        * native.combined_plan.cell_size[1]
        * native.combined_plan.cell_size[2];
    let ms = native.combined_plan.material.saturation_magnetisation;

    let exchange_energy = if native.combined_plan.enable_exchange {
        field_energy_from_full(
            magnetization_full,
            exchange_full,
            active_mask,
            ms,
            cell_volume,
        )
    } else {
        0.0
    };
    let demag_energy = if native.combined_plan.enable_demag {
        field_energy_from_full(magnetization_full, demag_full, active_mask, ms, cell_volume)
    } else {
        0.0
    };
    let external_energy = if native.combined_plan.external_field.is_some() {
        field_energy_from_full(
            magnetization_full,
            external_full,
            active_mask,
            ms,
            cell_volume,
        )
    } else {
        0.0
    };
    let global_grid = [
        native.global_grid[0] as usize,
        native.global_grid[1] as usize,
        native.global_grid[2] as usize,
    ];
    let mut per_object_scalars: std::collections::HashMap<
        String,
        std::collections::HashMap<String, f64>,
    > = std::collections::HashMap::new();
    let mut dmi_field = Vec::new();
    let mut anisotropy_field = Vec::new();
    let mut anisotropy_energy = 0.0;
    let mut dmi_energy = 0.0;
    let local_energy_factor = -0.5 * MU0 * ms * cell_volume;
    for layer in &native.layers {
        let mut local_exchange_energy = 0.0;
        let mut local_demag_energy = 0.0;
        let mut local_external_energy = 0.0;
        let mut mx_sum = 0.0;
        let mut my_sum = 0.0;
        let mut mz_sum = 0.0;
        let mut active_count = 0usize;
        for z in 0..layer.native_grid[2] {
            for y in 0..layer.native_grid[1] {
                for x in 0..layer.native_grid[0] {
                    let gx = layer.offset[0] + x;
                    let gy = layer.offset[1] + y;
                    let gz = layer.offset[2] + z;
                    let global_index =
                        gz * global_grid[1] * global_grid[0] + gy * global_grid[0] + gx;
                    if active_mask.is_some_and(|mask| !mask[global_index]) {
                        continue;
                    }
                    let m = magnetization_full[global_index];
                    mx_sum += m[0];
                    my_sum += m[1];
                    mz_sum += m[2];
                    active_count += 1;
                    if native.combined_plan.enable_exchange {
                        local_exchange_energy +=
                            local_energy_factor * dot(m, exchange_full[global_index]);
                    }
                    if native.combined_plan.enable_demag {
                        local_demag_energy +=
                            local_energy_factor * dot(m, demag_full[global_index]);
                    }
                    if native.combined_plan.external_field.is_some() {
                        local_external_energy +=
                            local_energy_factor * dot(m, external_full[global_index]);
                    }
                }
            }
        }
        let local_magnetization =
            extract_native_stacked_layer_field(magnetization_full, native, layer);
        let local_state = ExchangeLlgState::new(layer.context.problem.grid, local_magnetization)
            .map_err(|error| RunError {
                message: format!(
                    "native stacked local state for magnet '{}': {}",
                    layer.magnet_name, error
                ),
            })?;
        let local_observables = layer
            .context
            .problem
            .observe(&local_state)
            .map_err(|error| RunError {
                message: format!(
                    "native stacked local observables for magnet '{}': {}",
                    layer.magnet_name, error
                ),
            })?;
        let mut local_anisotropy = layer
            .context
            .problem
            .anisotropy_field(local_state.magnetization());
        zero_outside_active(
            &mut local_anisotropy,
            layer.context.problem.active_mask.as_deref(),
        );
        let mut local_dmi = local_observables.dmi_field;
        zero_outside_active(&mut local_dmi, layer.context.problem.active_mask.as_deref());
        let local_anisotropy_energy = local_observables.anisotropy_energy_joules;
        let local_dmi_energy = local_observables.dmi_energy_joules;
        anisotropy_energy += local_anisotropy_energy;
        dmi_energy += local_dmi_energy;
        anisotropy_field.extend(local_anisotropy);
        dmi_field.extend(local_dmi);

        let inv = if active_count > 0 {
            1.0 / active_count as f64
        } else {
            0.0
        };
        per_object_scalars.insert(
            layer.magnet_name.clone(),
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
                ("mx".to_string(), mx_sum * inv),
                ("my".to_string(), my_sum * inv),
                ("mz".to_string(), mz_sum * inv),
            ]),
        );
    }
    let max_dm_dt = max_rhs_norm_from_full(
        magnetization_full,
        effective_full,
        active_mask,
        native.combined_plan.material.damping,
        native.combined_plan.gyromagnetic_ratio,
        !llg_overdamped_uses_pure_damping(native.combined_plan.relaxation.as_ref()),
    );
    let max_h_eff = max_norm_from_full(effective_full, active_mask);
    let max_h_demag = max_norm_from_full(demag_full, active_mask);
    for values in per_object_scalars.values_mut() {
        values.insert("max_dm_dt".to_string(), max_dm_dt);
        values.insert("max_h_eff".to_string(), max_h_eff);
        values.insert("max_h_demag".to_string(), max_h_demag);
    }

    let magnetization = extract_native_stacked_field(magnetization_full, native);
    let effective_field = extract_native_stacked_field(effective_full, native);
    let torque_field = compute_torque_field(
        &magnetization,
        &effective_field,
        native.combined_plan.material.damping,
        !llg_overdamped_uses_pure_damping(native.combined_plan.relaxation.as_ref()),
    );
    let max_torque_apm = max_torque_residual_apm_from_field(&magnetization, &effective_field);

    Ok(StateObservables {
        magnetization,
        torque_field,
        exchange_field: extract_native_stacked_field(exchange_full, native),
        demag_field: extract_native_stacked_field(demag_full, native),
        external_field: extract_native_stacked_field(external_full, native),
        antenna_field: vec![[0.0, 0.0, 0.0]; cell_count],
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

pub(super) fn extract_native_stacked_field(
    full_field: &[[f64; 3]],
    native: &NativeStackedCudaPlan,
) -> Vec<[f64; 3]> {
    let mut values = Vec::new();
    for layer in &native.layers {
        values.extend(extract_native_stacked_layer_field(
            full_field, native, layer,
        ));
    }
    values
}

pub(super) fn extract_native_stacked_layer_field(
    full_field: &[[f64; 3]],
    native: &NativeStackedCudaPlan,
    layer: &NativeStackedLayer,
) -> Vec<[f64; 3]> {
    let global_grid = [
        native.global_grid[0] as usize,
        native.global_grid[1] as usize,
        native.global_grid[2] as usize,
    ];
    let mut values = Vec::new();
    for z in 0..layer.native_grid[2] {
        for y in 0..layer.native_grid[1] {
            for x in 0..layer.native_grid[0] {
                let gx = layer.offset[0] + x;
                let gy = layer.offset[1] + y;
                let gz = layer.offset[2] + z;
                let global_index = gz * global_grid[1] * global_grid[0] + gy * global_grid[0] + gx;
                values.push(full_field[global_index]);
            }
        }
    }
    values
}
