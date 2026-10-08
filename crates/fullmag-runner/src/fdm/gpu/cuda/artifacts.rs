//! CUDA FDM artifact and field-output helpers.

use crate::artifact_pipeline::ArtifactRecorder;
use crate::fdm::cpu::reference::resolved_antenna_zeeman_field_for_count;
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
use crate::preview::build_grid_preview_field;
use crate::quantities::normalized_quantity_name;
use crate::schedules::{advance_due_schedules, is_due, same_time, OutputSchedule};
use crate::types::{FieldSnapshot, LivePreviewField, LivePreviewRequest, RunError, StepStats};
use fullmag_ir::FdmPlanIR;

pub(crate) fn is_antenna_field_quantity(name: &str) -> bool {
    let base = name.split_once('.').map_or(name, |(base, _)| base);
    normalized_quantity_name(base).ok() == Some("H_ant")
}

pub(super) fn copy_resolved_antenna_field(
    plan: &FdmPlanIR,
    name: &str,
    cell_count: usize,
    solver_time_seconds: f64,
) -> Result<Vec<[f64; 3]>, RunError> {
    let physical_time_seconds = super::canonical_fdm_time(plan, solver_time_seconds);
    crate::antenna_fields::validate_fdm_antenna_sample_counts(plan, cell_count)?;
    let mut values =
        resolved_antenna_zeeman_field_for_count(plan, cell_count, physical_time_seconds);
    if values.len() != cell_count {
        return Err(RunError {
            message: format!(
                "resolved CUDA antenna field has {} samples; expected {cell_count}",
                values.len()
            ),
        });
    }
    if let Some((_, component)) = name.split_once('.') {
        let index = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(RunError {
                    message: format!(
                        "unsupported CUDA antenna snapshot component '{}' in '{}'",
                        other, name
                    ),
                });
            }
        };
        values = values
            .into_iter()
            .map(|value| [value[index], 0.0, 0.0])
            .collect();
    }
    Ok(values)
}

pub(crate) fn copy_cuda_live_preview_field(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    request: &LivePreviewRequest,
    original_grid: [u32; 3],
    active_mask: Option<&[bool]>,
    time_seconds: f64,
) -> Result<LivePreviewField, RunError> {
    if !is_antenna_field_quantity(&request.quantity) {
        return backend.copy_live_preview_field(request, original_grid, active_mask);
    }
    let cell_count = original_grid
        .into_iter()
        .try_fold(1usize, |count, extent| count.checked_mul(extent as usize))
        .ok_or_else(|| RunError {
            message: "CUDA antenna preview grid cell count overflows usize".to_string(),
        })?;
    if cell_count == 0 {
        return Err(RunError {
            message: "CUDA antenna preview requires a non-empty grid".to_string(),
        });
    }
    let base_quantity = request
        .quantity
        .split_once('.')
        .map_or(request.quantity.as_str(), |(base, _)| base);
    let values =
        copy_cuda_field_snapshot_with_plan(backend, plan, base_quantity, cell_count, time_seconds)?;
    let mut preview_request = request.clone();
    if let Some((base, component)) = request.quantity.split_once('.') {
        preview_request.quantity = base.to_string();
        preview_request.component = component.to_string();
    }
    Ok(build_grid_preview_field(
        &preview_request,
        &values,
        original_grid,
        active_mask,
    ))
}

pub(crate) fn capture_initial_cuda_fields(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
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
        if is_antenna_field_quantity(&name) {
            let values = copy_cuda_field_snapshot_with_plan(backend, plan, &name, cell_count, 0.0)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: 0,
                time: 0.0,
                solver_dt: 0.0,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (0 as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        } else if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(&name, 0, 0.0, 0.0)?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: 0,
                time: 0.0,
                solver_dt: 0.0,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (0 as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

pub(crate) fn record_cuda_due_outputs(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
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
        if is_antenna_field_quantity(&name) {
            let values =
                copy_cuda_field_snapshot_with_plan(backend, plan, &name, cell_count, stats.time)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: stats.time,
                solver_dt: stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        } else if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(&name, stats.step, stats.time, stats.dt)?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: stats.time,
                solver_dt: stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

pub(crate) fn record_cuda_final_outputs(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
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
        if is_antenna_field_quantity(&name) {
            let values = copy_cuda_field_snapshot_with_plan(
                backend,
                plan,
                &name,
                cell_count,
                latest_stats.time,
            )?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name,
                step: latest_stats.step,
                time: latest_stats.time,
                solver_dt: latest_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (latest_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        } else if artifacts.is_streaming() {
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
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (latest_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
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

pub(crate) fn copy_cuda_field_snapshot_with_plan(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    name: &str,
    cell_count: usize,
    time_seconds: f64,
) -> Result<Vec<[f64; 3]>, RunError> {
    if is_antenna_field_quantity(name) {
        return copy_resolved_antenna_field(plan, name, cell_count, time_seconds);
    }
    copy_cuda_field_snapshot(backend, name, cell_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{ResolvedAntennaZeemanMaskIR, TimeDependenceIR};

    #[test]
    fn cuda_antenna_snapshot_rejects_short_mask() {
        let mut plan = FdmPlanIR::default();
        plan.antenna_zeeman_masks = vec![ResolvedAntennaZeemanMaskIR {
            source: "antenna_1".into(),
            object: "magnet".into(),
            amplitude_b_t: 0.0,
            direction: [1.0, 0.0, 0.0],
            spatial_profile: None,
            waveform: None,
            field_xyz: vec![[0.0; 3]],
        }];
        let error = copy_resolved_antenna_field(&plan, "H_ant", 2, 0.0).unwrap_err();
        assert!(error.message.contains("expected 2"));
    }

    #[test]
    fn resolved_cuda_antenna_snapshot_scales_the_retained_basis_in_time() {
        let mut plan = FdmPlanIR::default();
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; 2];
        plan.antenna_zeeman_masks = vec![ResolvedAntennaZeemanMaskIR {
            source: "antenna_1".into(),
            object: "free".into(),
            amplitude_b_t: 1.0e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: None,
            waveform: Some(TimeDependenceIR::Sinusoidal {
                frequency_hz: 1.0,
                phase_rad: 0.0,
                offset: 0.0,
            }),
            field_xyz: vec![[2.0, 3.0, 4.0]; 2],
        }];

        let values = copy_resolved_antenna_field(&plan, "H_ant", 2, 0.25).unwrap();
        assert_eq!(values, vec![[2.0, 3.0, 4.0]; 2]);

        let values = copy_resolved_antenna_field(&plan, "H_ant.y", 2, 0.25).unwrap();
        assert_eq!(values, vec![[3.0, 0.0, 0.0]; 2]);
    }

    #[test]
    fn resolved_cuda_antenna_snapshot_uses_physical_time_after_stage_restart() {
        let mut plan = FdmPlanIR::default();
        plan.time_stage.start_time_s = 10.0;
        plan.antenna_zeeman_masks = vec![ResolvedAntennaZeemanMaskIR {
            source: "antenna_1".into(),
            object: "free".into(),
            amplitude_b_t: 1.0e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: None,
            waveform: Some(TimeDependenceIR::Sinusoidal {
                frequency_hz: 1.0,
                phase_rad: 0.0,
                offset: 0.0,
            }),
            field_xyz: vec![[2.0, 3.0, 4.0]],
        }];

        let values = copy_resolved_antenna_field(&plan, "H_ant", 1, 0.25).unwrap();
        assert_eq!(values, vec![[2.0, 3.0, 4.0]]);

        let values = copy_resolved_antenna_field(&plan, "H_ant", 1, 0.75).unwrap();
        assert_eq!(values, vec![[-2.0, -3.0, -4.0]]);
    }
}
