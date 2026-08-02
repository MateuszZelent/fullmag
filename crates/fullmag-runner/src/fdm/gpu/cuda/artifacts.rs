//! CUDA FDM artifact and field-output helpers.

use crate::artifact_pipeline::ArtifactRecorder;
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
use crate::quantities::normalized_quantity_name;
use crate::schedules::{advance_due_schedules, is_due, same_time, OutputSchedule};
use crate::types::{FieldSnapshot, RunError, StepStats};

pub(crate) fn capture_initial_cuda_fields(
    backend: &NativeFdmBackend,
    cell_count: usize,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(0.0, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(&name, 0, 0.0, 0.0)?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: 0,
                time: 0.0,
                solver_dt: 0.0,
                values,
            })?;
        }
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

pub(crate) fn record_cuda_due_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    stats: &StepStats,
    magnetization: Option<&[[f64; 3]]>,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        let mut sampled_stats = stats.clone();
        if let Some(magnetization) = magnetization {
            backend.apply_average_m_to_step_stats_from_values(&mut sampled_stats, magnetization);
        } else {
            backend.apply_average_m_to_step_stats(&mut sampled_stats)?;
        }
        artifacts.record_scalar(&sampled_stats)?;
        steps.push(sampled_stats);
        advance_due_schedules(scalar_schedules, stats.time);
    }

    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(stats.time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(&name, stats.step, stats.time, stats.dt)?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: stats.time,
                solver_dt: stats.dt,
                values,
            })?;
        }
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

pub(crate) fn record_cuda_final_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    latest_stats: Option<StepStats>,
    default_scalar_trace: bool,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let Some(latest_stats) = latest_stats else {
        return Ok(());
    };

    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, latest_stats.time))
            .unwrap_or(true);
    if need_scalar {
        let mut final_stats = latest_stats.clone();
        backend.apply_average_m_to_step_stats(&mut final_stats)?;
        artifacts.record_scalar(&final_stats)?;
        steps.push(final_stats);
    }
    let _ = scalar_schedules;

    let requested_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|time| !same_time(time, latest_stats.time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in requested_field_names {
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(
                &name,
                latest_stats.step,
                latest_stats.time,
                latest_stats.dt,
            )?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name,
                step: latest_stats.step,
                time: latest_stats.time,
                solver_dt: latest_stats.dt,
                values,
            })?;
        }
    }

    Ok(())
}

pub(crate) fn copy_cuda_field_snapshot(
    backend: &NativeFdmBackend,
    name: &str,
    cell_count: usize,
) -> Result<Vec<[f64; 3]>, RunError> {
    let quantity = normalized_quantity_name(name).map_err(|_| RunError {
        message: format!("unsupported CUDA field snapshot '{}'", name),
    })?;
    match quantity {
        "m" => backend.copy_m(cell_count),
        "H_ex" => backend.copy_h_ex(cell_count),
        "H_demag" => backend.copy_h_demag(cell_count),
        "H_ext" => backend.copy_h_ext(cell_count),
        "H_oe" => backend.copy_h_oe(cell_count),
        "H_ani" => backend.copy_h_ani(cell_count),
        "H_eff" => backend.copy_h_eff(cell_count),
        other => Err(RunError {
            message: format!("unsupported CUDA field snapshot '{}'", other),
        }),
    }
}
