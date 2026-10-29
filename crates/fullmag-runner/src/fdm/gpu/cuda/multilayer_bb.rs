//! Host-controlled projected-gradient BB over native CUDA multilayer operators.
//!
//! The optimizer owns only layer-major trial vectors. The native CUDA context
//! evaluates the coupled fields and energies for every trial; publication is
//! limited to the initial state and accepted iterates.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use fullmag_ir::{FdmMultilayerPlanIR, OutputIR};

use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::fdm::gpu::cuda::native::{
    is_cuda_available, reject_cuda_multilayer_containment, NativeFdmBackend,
};
use crate::fdm::schedules::record_due_fields;
use crate::fdm::validate_multilayer_grid_budget;
use crate::relaxation::multilayer_bb::{execute_multilayer_bb, MultilayerBbEvent};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, RunError, RunResult, RunStatus,
    StateObservables, StepAction, StepStats, StepUpdate,
};

use super::{
    advance_due_schedules, build_contexts_and_states, cuda_multilayer_kernel_admission_model,
    emit_multilayer_terminal_step_updates, make_multilayer_live_step_update, same_time,
    snapshot_native_multilayer_observables, validate_cuda_multilayer_execution_contract,
    DeviceResidentMultilayerTransferCounters,
};

const LIVE_FIELD_MIN_INTERVAL: Duration = Duration::from_secs(2);

type LiveStepCallback<'grid, 'layout, 'callback> = (
    &'grid [u32; 3],
    u64,
    Option<&'layout serde_json::Value>,
    &'callback mut dyn FnMut(StepUpdate) -> StepAction,
);

pub(super) fn execute_cuda_fdm_multilayer_projected_bb(
    plan: &FdmMultilayerPlanIR,
    outputs: &[OutputIR],
    mut live: Option<LiveStepCallback<'_, '_, '_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    if let Some(message) = fullmag_plan::fdm_multilayer_cuda_projected_bb_error(plan) {
        return Err(RunError { message });
    }
    reject_cuda_multilayer_containment(plan.enable_demag, &plan.mode, &plan.layers)?;
    validate_multilayer_grid_budget(plan, cuda_multilayer_kernel_admission_model(plan))?;
    validate_cuda_multilayer_execution_contract(plan)?;
    if !is_cuda_available() {
        return Err(RunError {
            message: "projected_gradient_bb requested the native CUDA multilayer lane, but CUDA is not available".into(),
        });
    }

    let control = plan
        .relaxation
        .as_ref()
        .filter(|control| {
            control.algorithm == fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
        })
        .ok_or_else(|| RunError {
            message: "native CUDA multilayer BB requires projected_gradient_bb relaxation control"
                .into(),
        })?;
    let (contexts, _) = build_contexts_and_states(plan, false)?;
    let mut backend = NativeFdmBackend::create_multilayer_v2(plan)?;
    let device_info = backend.device_info().ok();
    let mut transfer_counters = DeviceResidentMultilayerTransferCounters::new(
        plan.layers.len(),
        std::mem::size_of::<f64>(),
    );
    for layer in &plan.layers {
        transfer_counters.record_setup_h2d_vector(layer.initial_magnetization.len());
    }

    let mut stage_telemetry = None;
    backend.refresh_multilayer_demag()?;
    if plan.enable_demag {
        stage_telemetry = Some(backend.snapshot_multilayer_demag_stage_telemetry(
            u64::try_from(plan.layers.len()).map_err(|_| RunError {
                message: "CUDA multilayer layer count does not fit telemetry range".into(),
            })?,
        )?);
    }
    let initial_observables =
        snapshot_native_multilayer_observables(plan, &contexts, &backend, &mut transfer_counters)?;
    let initial_magnetization = initial_observables.magnetization.clone();
    let initial_provenance = projected_gradient_bb_provenance(
        plan,
        device_info.clone(),
        stage_telemetry.clone(),
        transfer_counters,
    )?;
    let mut artifacts = match artifact_writer {
        Some(writer) => ArtifactRecorder::streaming(initial_provenance, writer),
        None => ArtifactRecorder::in_memory(initial_provenance),
    };
    let mut scalar_schedules = crate::schedules::collect_scalar_schedules(outputs)?;
    let mut field_schedules = crate::schedules::collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();
    let total_cells = plan
        .layers
        .iter()
        .try_fold(0usize, |sum, layer| {
            sum.checked_add(layer.initial_magnetization.len())
        })
        .ok_or_else(|| RunError {
            message: "native CUDA multilayer cell count overflow".into(),
        })?;

    let has_active_masks = contexts
        .iter()
        .any(|context| context.problem.active_mask.is_some());
    let mut active_mask = has_active_masks.then(|| Vec::with_capacity(total_cells));
    let mut ms_apm = Vec::with_capacity(total_cells);
    let mut volumes_m3 = Vec::with_capacity(total_cells);
    for (layer, context) in plan.layers.iter().zip(&contexts) {
        let cell_count = layer.initial_magnetization.len();
        let ms = context.problem.material.saturation_magnetisation;
        let cell_volume = context.problem.cell_size.volume();
        for cell in 0..cell_count {
            let active = context
                .problem
                .active_mask
                .as_ref()
                .is_none_or(|mask| mask[cell]);
            ms_apm.push(ms);
            volumes_m3.push(if active { cell_volume } else { 0.0 });
            if let Some(active_mask) = active_mask.as_mut() {
                active_mask.push(active);
            }
        }
    }

    let evaluation_count = Cell::new(1u64);
    let started = Instant::now();
    let mut last_live_field_update = Instant::now();
    let mut last_accepted_step = None;
    let mut steps = Vec::<StepStats>::new();
    // Output schedules are physical-time schedules. BB intentionally holds
    // time at zero, so accepted-step autosaves are deduplicated by (name, step)
    // below rather than by the repeated physical time.
    let mut scheduled_field_steps = BTreeMap::<String, u64>::new();

    let outcome = {
        let mut evaluate = |trial: &[[f64; 3]]| -> Result<StateObservables, RunError> {
            if trial.len() != total_cells {
                return Err(RunError {
                    message: "native CUDA multilayer BB trial has the wrong layer-major cell count"
                        .into(),
                });
            }
            let mut offset = 0usize;
            for (layer_index, layer) in plan.layers.iter().enumerate() {
                let end = offset
                    .checked_add(layer.initial_magnetization.len())
                    .filter(|end| *end <= trial.len())
                    .ok_or_else(|| RunError {
                        message: "native CUDA multilayer BB trial layer range overflow".into(),
                    })?;
                let native_layer_index = u32::try_from(layer_index).map_err(|_| RunError {
                    message: "native CUDA multilayer layer index exceeds the ABI range".into(),
                })?;
                backend.upload_layer_magnetization(native_layer_index, &trial[offset..end])?;
                transfer_counters.record_bb_trial_h2d_vector(layer.initial_magnetization.len());
                offset = end;
            }
            if offset != trial.len() {
                return Err(RunError {
                    message: "native CUDA multilayer BB trial was not fully split into layers"
                        .into(),
                });
            }
            backend.refresh_multilayer_demag()?;
            if plan.enable_demag {
                stage_telemetry = Some(backend.snapshot_multilayer_demag_stage_telemetry(
                    u64::try_from(plan.layers.len()).map_err(|_| RunError {
                        message: "CUDA multilayer layer count does not fit telemetry range".into(),
                    })?,
                )?);
            }
            let observables = snapshot_native_multilayer_observables(
                plan,
                &contexts,
                &backend,
                &mut transfer_counters,
            )?;
            evaluation_count.set(evaluation_count.get().checked_add(1).ok_or_else(|| {
                RunError {
                    message: "native CUDA multilayer BB evaluation count overflow".into(),
                }
            })?);
            Ok(observables)
        };

        let mut observe = |event: MultilayerBbEvent<'_>| -> Result<StepAction, RunError> {
            match event {
                MultilayerBbEvent::Accepted { observables, stats } => {
                    if stats.time != 0.0 || stats.dt != 0.0 {
                        return Err(RunError {
                            message: "native CUDA multilayer BB must not advance physical time"
                                .into(),
                        });
                    }
                    match last_accepted_step {
                        None if stats.step != 0 => {
                            return Err(RunError {
                                message: "native CUDA multilayer BB did not publish its initial accepted state".into(),
                            });
                        }
                        Some(previous) if stats.step <= previous => {
                            return Err(RunError {
                                message: "native CUDA multilayer BB accepted-step counter did not increase".into(),
                            });
                        }
                        _ => {}
                    }
                    last_accepted_step = Some(stats.step);

                    let scalar_due = default_scalar_trace
                        || scalar_schedules.iter().any(|schedule| {
                            crate::schedules::is_due(stats.time, schedule.next_time)
                        });
                    if scalar_due {
                        artifacts.record_scalar(stats)?;
                        steps.push(stats.clone());
                        advance_due_schedules(&mut scalar_schedules, stats.time);
                    }

                    let scheduled_now = field_schedules
                        .iter()
                        .filter(|schedule| crate::schedules::is_due(stats.time, schedule.next_time))
                        .map(|schedule| schedule.name.clone())
                        .collect::<Vec<_>>();
                    record_due_fields(
                        observables,
                        stats.step,
                        stats.time,
                        stats.dt,
                        &mut field_schedules,
                        &mut artifacts,
                    )?;
                    for name in scheduled_now {
                        scheduled_field_steps.insert(name, stats.step);
                    }
                    let autosave_fields = artifacts.due_accepted_step_fields(stats.step, false);
                    record_bb_accepted_step_autosave_fields(
                        &autosave_fields,
                        observables,
                        stats.step,
                        stats.time,
                        stats.dt,
                        &scheduled_field_steps,
                        &mut artifacts,
                    )?;

                    let live_fields_due =
                        live.is_some() && live_field_cadence_due(last_live_field_update.elapsed());
                    if let Some((grid, field_every_n, layout, on_step)) = live.as_mut() {
                        if live_fields_due {
                            last_live_field_update = Instant::now();
                            let update = make_multilayer_live_step_update(
                                plan,
                                &contexts,
                                Some(observables),
                                stats,
                                [grid[0], grid[1], grid[2]],
                                *layout,
                                *field_every_n,
                                &crate::quantities::field_materialization_quantity_ids(),
                                true,
                                false,
                                None,
                                None,
                            );
                            return Ok((**on_step)(update));
                        }
                        if stats.step == 0 {
                            let update = make_multilayer_live_step_update(
                                plan,
                                &contexts,
                                Some(observables),
                                stats,
                                [grid[0], grid[1], grid[2]],
                                *layout,
                                *field_every_n,
                                &[],
                                false,
                                false,
                                None,
                                None,
                            );
                            return Ok((**on_step)(update));
                        }
                    }
                    Ok(StepAction::Continue)
                }
                MultilayerBbEvent::Poll { stats } => {
                    if let Some((grid, field_every_n, layout, on_step)) = live.as_mut() {
                        let update = make_multilayer_live_step_update(
                            plan,
                            &contexts,
                            None,
                            stats,
                            [grid[0], grid[1], grid[2]],
                            *layout,
                            *field_every_n,
                            &[],
                            false,
                            false,
                            None,
                            None,
                        );
                        Ok((**on_step)(update))
                    } else {
                        Ok(StepAction::Continue)
                    }
                }
            }
        };

        execute_multilayer_bb(
            initial_observables,
            control,
            &ms_apm,
            &volumes_m3,
            active_mask.as_deref(),
            &mut evaluate,
            &mut observe,
        )?
    };

    for _ in 0..evaluation_count.get() {
        artifacts.observe_energy_evaluation();
    }

    let final_stats = outcome.final_stats.clone();
    let final_observables = &outcome.final_observables;
    let final_magnetization = final_observables.magnetization.clone();
    let final_autosave_fields = artifacts.due_accepted_step_fields(final_stats.step, true);

    if let Some((grid, field_every_n, layout, on_step)) = live.as_mut() {
        emit_multilayer_terminal_step_updates(
            plan,
            &contexts,
            Some(final_observables),
            &final_stats,
            [grid[0], grid[1], grid[2]],
            *layout,
            *field_every_n,
            None,
            None,
            &mut **on_step,
        );
    }

    record_terminal_scheduled_fields(
        &mut field_schedules,
        final_observables,
        final_stats.step,
        final_stats.time,
        final_stats.dt,
        &mut scheduled_field_steps,
        &mut artifacts,
    )?;
    record_bb_accepted_step_autosave_fields(
        &final_autosave_fields,
        final_observables,
        final_stats.step,
        final_stats.time,
        final_stats.dt,
        &scheduled_field_steps,
        &mut artifacts,
    )?;
    if !steps
        .iter()
        .any(|step| step.step == final_stats.step && same_time(step.time, final_stats.time))
    {
        artifacts.record_scalar(&final_stats)?;
        steps.push(final_stats.clone());
    }

    let status = if outcome.cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::resolve_stage_completion(
        status,
        Some(control),
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: Some(final_stats.max_torque_Apm),
            torque_confirmed: outcome.torque_confirmed,
            accepted_energy_plateau_range_j: outcome.final_energy_plateau_range_j,
            steps: outcome.accepted_steps,
            relaxation_time_s: None,
            numerical_stagnation: outcome.numerical_stagnation,
        },
    );

    artifacts.update_provenance(projected_gradient_bb_provenance(
        plan,
        device_info,
        stage_telemetry,
        transfer_counters,
    )?);
    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization,
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn live_field_cadence_due(elapsed: Duration) -> bool {
    elapsed >= LIVE_FIELD_MIN_INTERVAL
}

fn field_was_sampled_at_accepted_step(
    name: &str,
    step: u64,
    scheduled_field_steps: &BTreeMap<String, u64>,
) -> bool {
    scheduled_field_steps.get(name) == Some(&step)
}

fn record_terminal_scheduled_fields(
    schedules: &mut [crate::schedules::OutputSchedule],
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    scheduled_field_steps: &mut BTreeMap<String, u64>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    for schedule in schedules {
        if field_was_sampled_at_accepted_step(&schedule.name, step, scheduled_field_steps) {
            continue;
        }
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step,
            time,
            solver_dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: step.saturating_add(1),
            values: FieldSnapshot::flatten_vec3(
                crate::fdm::artifacts::select_state_observable_field(
                    observables,
                    &schedule.name,
                    false,
                )?,
            ),
        })?;
        scheduled_field_steps.insert(schedule.name.clone(), step);
        schedule.last_sampled_time = Some(time);
    }
    Ok(())
}

fn record_bb_accepted_step_autosave_fields(
    names: &[String],
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    scheduled_field_steps: &BTreeMap<String, u64>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    for name in names {
        if field_was_sampled_at_accepted_step(name, step, scheduled_field_steps) {
            continue;
        }
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time,
            solver_dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: step.saturating_add(1),
            values: FieldSnapshot::flatten_vec3(
                crate::fdm::artifacts::select_state_observable_field(observables, name, false)?,
            ),
        })?;
    }
    Ok(())
}

fn projected_gradient_bb_provenance(
    plan: &FdmMultilayerPlanIR,
    device_info: Option<crate::fdm::gpu::cuda::native::DeviceInfo>,
    stage_telemetry: Option<crate::types::FdmMultilayerStageTelemetry>,
    transfer_counters: DeviceResidentMultilayerTransferCounters,
) -> Result<ExecutionProvenance, RunError> {
    let fdm_fft_execution =
        crate::fdm::resolve_cuda_fft_execution_for_demag(plan.enable_demag, plan.fft.as_ref())?;
    Ok(ExecutionProvenance {
        execution_engine: "cuda_native_multilayer_convolution".into(),
        precision: "double".into(),
        fdm_fft_execution,
        demag_operator_kind: plan
            .enable_demag
            .then(|| "native_multilayer_tensor_fft_newell".into()),
        fft_backend: plan.enable_demag.then(|| "cuFFT".into()),
        device_name: device_info.as_ref().map(|info| info.name.clone()),
        compute_capability: device_info
            .as_ref()
            .map(|info| info.compute_capability.clone()),
        cuda_driver_version: device_info.as_ref().map(|info| info.driver_version),
        cuda_runtime_version: device_info.as_ref().map(|info| info.runtime_version),
        requested_energy_minimizer: Some("projected_gradient_bb".into()),
        resolved_energy_minimizer: Some("projected_gradient_bb".into()),
        energy_minimizer_realization: crate::relaxation::native_direct_minimizer_realization(
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            true,
        )
        .map(str::to_string),
        requested_demag_realization: plan
            .enable_demag
            .then(|| "native_multilayer_tensor_fft_newell".into()),
        resolved_demag_realization: plan
            .enable_demag
            .then(|| "native_multilayer_tensor_fft_newell".into()),
        fdm_multilayer_transfer_telemetry: Some(
            transfer_counters.projected_gradient_bb_telemetry(plan.precision),
        ),
        fdm_multilayer_stage_telemetry: stage_telemetry,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observables_with_demag(demag_field: Vec<[f64; 3]>) -> StateObservables {
        StateObservables {
            magnetization: Vec::new(),
            torque_field: Vec::new(),
            exchange_field: Vec::new(),
            demag_field,
            external_field: Vec::new(),
            antenna_field: Vec::new(),
            drive_field: Vec::new(),
            effective_field: Vec::new(),
            anisotropy_field: Vec::new(),
            dmi_field: Vec::new(),
            rotated_dmi_field: Vec::new(),
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
            rotated_dmi_energy: 0.0,
            total_energy: 0.0,
            max_dm_dt: 0.0,
            max_rhs_all_norm_per_s: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_all_Apm: 0.0,
            per_object_scalars: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn live_heavy_field_cadence_is_wall_clock_bounded() {
        assert!(!live_field_cadence_due(Duration::from_millis(1_999)));
        assert!(live_field_cadence_due(Duration::from_secs(2)));
    }

    #[test]
    fn trial_uploads_are_in_transfer_totals_without_becoming_warm_steps() {
        let mut counters = super::super::DeviceResidentMultilayerTransferCounters::new(2, 8);
        counters.record_setup_h2d_vector(2);
        counters.record_bb_trial_h2d_vector(2);
        for _ in 0..6 {
            counters.record_observed_snapshot_d2h_vector(2);
        }
        counters.finish_host_snapshot();

        let telemetry =
            counters.projected_gradient_bb_telemetry(fullmag_ir::ExecutionPrecision::Double);
        assert_eq!(telemetry.setup_h2d_transfer_count, 1);
        assert_eq!(telemetry.setup_h2d_bytes, 48);
        assert_eq!(telemetry.observed_snapshot_d2h_transfer_count, 6);
        assert_eq!(telemetry.observed_snapshot_d2h_bytes, 288);
        assert_eq!(telemetry.warm_step_h2d_transfer_count, 0);
        assert_eq!(telemetry.warm_step_d2h_transfer_count, 0);
        assert_eq!(telemetry.h2d_transfer_count, 2);
        assert_eq!(telemetry.h2d_bytes, 96);
        assert_eq!(telemetry.d2h_transfer_count, 6);
        assert_eq!(telemetry.d2h_bytes, 288);
        assert!(telemetry.execution_shape.contains("projected_gradient_bb"));
        assert!(telemetry
            .data_residency
            .contains("host_bb_trial_roundtrips"));
    }

    #[test]
    fn terminal_field_at_same_time_as_initial_is_retained_when_accepted_step_changed() {
        let name = "H_demag".to_string();
        let mut schedules = vec![crate::schedules::OutputSchedule {
            name: name.clone(),
            every_seconds: 1.0,
            next_time: 1.0,
            last_sampled_time: Some(0.0),
        }];
        let mut sampled_steps = BTreeMap::from([(name.clone(), 0)]);
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance::default());
        artifacts
            .record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: 0,
                time: 0.0,
                solver_dt: 0.0,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: 1,
                values: vec![1.0, 2.0, 3.0],
            })
            .expect("initial output snapshot");

        record_terminal_scheduled_fields(
            &mut schedules,
            &observables_with_demag(vec![[4.0, 5.0, 6.0]]),
            1,
            0.0,
            0.0,
            &mut sampled_steps,
            &mut artifacts,
        )
        .expect("changed terminal output snapshot");

        let (snapshots, count, _) = artifacts.finish();
        assert_eq!(count, 2);
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].step, 0);
        assert_eq!(snapshots[1].step, 1);
        assert_eq!(snapshots[0].time, 0.0);
        assert_eq!(snapshots[1].time, 0.0);
        assert_ne!(snapshots[0].values, snapshots[1].values);
        assert_eq!(snapshots[1].values, vec![4.0, 5.0, 6.0]);
    }
}
