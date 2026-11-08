//! CUDA FDM artifact and field-output helpers.

use crate::artifact_pipeline::ArtifactRecorder;
use crate::fdm::cpu::reference::resolved_antenna_zeeman_field_for_count;
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
use crate::preview::build_grid_preview_field;
use crate::quantities::normalized_quantity_name;
use crate::schedules::{advance_due_schedules, is_due, same_time, OutputSchedule};
use crate::types::{FieldSnapshot, LivePreviewField, LivePreviewRequest, RunError, StepStats};
use fullmag_ir::FdmPlanIR;

const CUDA_FIELD_SNAPSHOT_POOL_EXHAUSTED: &str = "fdm_async_snapshot_pool_exhausted";

fn capture_cuda_field_snapshot_after_pool_drain<T>(
    mut capture: impl FnMut() -> Result<T, RunError>,
    drain_prior_snapshots: impl FnOnce() -> Result<(), RunError>,
) -> Result<T, RunError> {
    match capture() {
        Ok(snapshot) => Ok(snapshot),
        Err(error) if error.message == CUDA_FIELD_SNAPSHOT_POOL_EXHAUSTED => {
            drain_prior_snapshots()?;
            // Pool exhaustion creates no native handle. Retry exactly once at
            // the same accepted state after earlier snapshots release theirs.
            capture()
        }
        Err(error) => Err(error),
    }
}

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

#[derive(Default)]
pub(crate) struct CudaFieldCaptureLedger {
    // execute_cuda_fdm processes accepted states monotonically, so only the
    // latest accepted clock per quantity is needed for cross-path deduplication.
    last_capture_by_name: std::collections::HashMap<String, CudaFieldCapture>,
}

struct CudaFieldCapture {
    accepted_step: u64,
    time: f64,
}

impl CudaFieldCaptureLedger {
    fn contains(&self, name: &str, accepted_step: u64, time: f64) -> bool {
        self.last_capture_by_name.get(name).is_some_and(|capture| {
            capture.accepted_step == accepted_step && same_time(capture.time, time)
        })
    }

    /// Record only after the corresponding field snapshot was accepted by the writer.
    fn mark_recorded(&mut self, name: &str, accepted_step: u64, time: f64) {
        self.last_capture_by_name.insert(
            name.to_string(),
            CudaFieldCapture {
                accepted_step,
                time,
            },
        );
    }

    fn uncaptured_names(
        &self,
        candidates: impl IntoIterator<Item = String>,
        accepted_step: u64,
        time: f64,
    ) -> Vec<String> {
        let mut uncaptured = Vec::new();
        for name in candidates {
            if !self.contains(&name, accepted_step, time)
                && !uncaptured.iter().any(|existing| existing == &name)
            {
                uncaptured.push(name);
            }
        }
        uncaptured
    }
}

fn append_unique_field_names(
    names: &mut Vec<String>,
    candidates: impl IntoIterator<Item = String>,
) {
    for candidate in candidates {
        if !names.iter().any(|existing| existing == &candidate) {
            names.push(candidate);
        }
    }
}

pub(crate) fn capture_initial_cuda_fields(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    cell_count: usize,
    stats: &StepStats,
    field_schedules: &mut [OutputSchedule],
    capture_ledger: &mut CudaFieldCaptureLedger,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let mut due_field_names = Vec::new();
    append_unique_field_names(
        &mut due_field_names,
        field_schedules
            .iter()
            .filter(|schedule| is_due(stats.time, schedule.next_time))
            .map(|schedule| schedule.name.clone()),
    );
    // The stage origin is a real initialized state even when an accepted-step
    // cadence does not divide its resumed step index.
    #[cfg(feature = "fem-gpu")]
    append_unique_field_names(
        &mut due_field_names,
        artifacts.due_accepted_step_fields(stats.step, true),
    );

    for name in capture_ledger.uncaptured_names(due_field_names, stats.step, stats.time) {
        if is_antenna_field_quantity(&name) {
            let values =
                copy_cuda_field_snapshot_with_plan(backend, plan, &name, cell_count, stats.time)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: super::canonical_fdm_publication_time(plan, stats.time),
                solver_dt: stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        } else if artifacts.is_streaming() {
            let snapshot = capture_cuda_field_snapshot_after_pool_drain(
                || backend.begin_field_snapshot(&name, stats.step, super::canonical_fdm_publication_time(plan, stats.time), stats.dt),
                || artifacts.drain_prior_native_field_snapshots(),
            )?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: super::canonical_fdm_publication_time(plan, stats.time),
                solver_dt: stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
        capture_ledger.mark_recorded(&name, stats.step, stats.time);
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

fn scalar_row_is_scheduled(output_ir_due: bool, stage_table_due: bool) -> bool {
    output_ir_due || stage_table_due
}

fn steps_end_at_same_accepted_state(steps: &[StepStats], candidate: &StepStats) -> bool {
    steps
        .last()
        .is_some_and(|last| last.step == candidate.step && same_time(last.time, candidate.time))
}

fn select_due_scalar_stats(
    output_ir_due: bool,
    stage_table_due: bool,
    output_ir_stats: &StepStats,
    stage_table_stats: Option<StepStats>,
) -> Result<Option<StepStats>, RunError> {
    if stage_table_due {
        return stage_table_stats.map(Some).ok_or_else(|| RunError {
            message: "accepted-step table row is due without a full artifact snapshot".into(),
        });
    }
    Ok(output_ir_due.then(|| output_ir_stats.clone()))
}

/// Emit the initialized scalar state before the first CUDA FDM solver step
/// when the default trace, a physical-time output, or an accepted-step table is due.
pub(crate) fn record_cuda_initial_scalar(
    plan: &FdmPlanIR,
    stats: &StepStats,
    default_scalar_trace: bool,
    scalar_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let output_ir_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    let scalar_due = default_scalar_trace
        || scalar_row_is_scheduled(output_ir_due, artifacts.accepted_step_table_due(stats.step));
    if !scalar_due {
        return Ok(());
    }

    let published = super::canonical_fdm_publication_stats(plan, stats.clone());
    artifacts.record_scalar(&published)?;
    steps.push(published);
    advance_due_schedules(scalar_schedules, stats.time);
    Ok(())
}

pub(crate) fn record_cuda_due_outputs(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    cell_count: usize,
    stats: &StepStats,
    magnetization: Option<&[[f64; 3]]>,
    stage_table_stats: Option<StepStats>,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    capture_ledger: &mut CudaFieldCaptureLedger,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let output_ir_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    let stage_table_due = artifacts.accepted_step_table_due(stats.step);
    let sampled_stats = if output_ir_due && !stage_table_due {
        let mut sampled_stats = stats.clone();
        if let Some(magnetization) = magnetization {
            backend.apply_average_m_to_step_stats_from_values(&mut sampled_stats, magnetization);
        } else {
            backend.apply_average_m_to_step_stats(&mut sampled_stats)?;
        }
        sampled_stats
    } else {
        stats.clone()
    };
    if let Some(sampled_stats) = select_due_scalar_stats(
        output_ir_due,
        stage_table_due,
        &sampled_stats,
        stage_table_stats,
    )? {
        let published = super::canonical_fdm_publication_stats(plan, sampled_stats);
        artifacts.record_scalar(&published)?;
        steps.push(published);
        if output_ir_due {
            advance_due_schedules(scalar_schedules, stats.time);
        }
    }

    let mut due_field_names = Vec::new();
    append_unique_field_names(
        &mut due_field_names,
        field_schedules
            .iter()
            .filter(|schedule| is_due(stats.time, schedule.next_time))
            .map(|schedule| schedule.name.clone()),
    );
    #[cfg(feature = "fem-gpu")]
    append_unique_field_names(
        &mut due_field_names,
        artifacts.due_accepted_step_fields(stats.step, false),
    );
    for name in capture_ledger.uncaptured_names(due_field_names, stats.step, stats.time) {
        if is_antenna_field_quantity(&name) {
            let values =
                copy_cuda_field_snapshot_with_plan(backend, plan, &name, cell_count, stats.time)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: super::canonical_fdm_publication_time(plan, stats.time),
                solver_dt: stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        } else if artifacts.is_streaming() {
            let snapshot = capture_cuda_field_snapshot_after_pool_drain(
                || backend.begin_field_snapshot(&name, stats.step, super::canonical_fdm_publication_time(plan, stats.time), stats.dt),
                || artifacts.drain_prior_native_field_snapshots(),
            )?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: super::canonical_fdm_publication_time(plan, stats.time),
                solver_dt: stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
        capture_ledger.mark_recorded(&name, stats.step, stats.time);
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

pub(crate) fn record_cuda_final_outputs(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    cell_count: usize,
    latest_stats: Option<StepStats>,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    capture_ledger: &mut CudaFieldCaptureLedger,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let Some(latest_stats) = latest_stats else {
        return Ok(());
    };

    let published = super::canonical_fdm_publication_stats(plan, latest_stats.clone());
    let need_scalar = !steps_end_at_same_accepted_state(steps, &published);
    if need_scalar {
        let mut final_stats = latest_stats.clone();
        backend.apply_average_m_to_step_stats(&mut final_stats)?;
        let published = super::canonical_fdm_publication_stats(plan, final_stats);
        artifacts.record_scalar(&published)?;
        steps.push(published);
    }
    let _ = scalar_schedules;

    let mut requested_field_names = Vec::new();
    append_unique_field_names(
        &mut requested_field_names,
        field_schedules
            .iter()
            .filter(|schedule| {
                schedule
                    .last_sampled_time
                    .map(|time| !same_time(time, latest_stats.time))
                    .unwrap_or(true)
            })
            .map(|schedule| schedule.name.clone()),
    );
    #[cfg(feature = "fem-gpu")]
    append_unique_field_names(
        &mut requested_field_names,
        artifacts.due_accepted_step_fields(latest_stats.step, true),
    );

    for name in capture_ledger.uncaptured_names(
        requested_field_names,
        latest_stats.step,
        latest_stats.time,
    ) {
        if is_antenna_field_quantity(&name) {
            let values = copy_cuda_field_snapshot_with_plan(
                backend,
                plan,
                &name,
                cell_count,
                latest_stats.time,
            )?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: latest_stats.step,
                time: super::canonical_fdm_publication_time(plan, latest_stats.time),
                solver_dt: latest_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (latest_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        } else if artifacts.is_streaming() {
            let snapshot = capture_cuda_field_snapshot_after_pool_drain(
                || {
                    backend.begin_field_snapshot(
                        &name,
                        latest_stats.step,
                        super::canonical_fdm_publication_time(plan, latest_stats.time),
                        latest_stats.dt,
                    )
                },
                || artifacts.drain_prior_native_field_snapshots(),
            )?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: latest_stats.step,
                time: super::canonical_fdm_publication_time(plan, latest_stats.time),
                solver_dt: latest_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (latest_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
        capture_ledger.mark_recorded(&name, latest_stats.step, latest_stats.time);
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
    fn accepted_step_table_snapshot_wins_when_output_scalar_is_also_due() {
        let narrow_output = StepStats {
            step: 10,
            time: 1.0e-9,
            e_demag: 0.0,
            e_total: 0.0,
            ..StepStats::default()
        };
        let full_table = StepStats {
            step: 10,
            time: 1.0e-9,
            e_demag: 5.0e-19,
            e_total: 7.0e-19,
            ..StepStats::default()
        };

        let selected = select_due_scalar_stats(
            true,
            true,
            &narrow_output,
            Some(full_table.clone()),
        )
        .expect("table/output overlap selects full table snapshot")
        .expect("one union scalar row");
        assert_eq!(selected.step, 10);
        assert_eq!(selected.time, 1.0e-9);
        assert_eq!(selected.e_demag, 5.0e-19);
        assert_eq!(selected.e_total, 7.0e-19);
    }

    #[test]
    fn accepted_step_table_scalar_rows_union_and_deduplicate_by_step_and_time() {
        assert!(scalar_row_is_scheduled(false, true));
        assert!(scalar_row_is_scheduled(true, true));
        assert!(!scalar_row_is_scheduled(false, false));

        let initial = StepStats {
            step: 0,
            time: 0.0,
            ..StepStats::default()
        };
        let direct_minimizer_terminal = StepStats {
            step: 271,
            time: 0.0,
            ..StepStats::default()
        };
        assert!(!steps_end_at_same_accepted_state(
            std::slice::from_ref(&initial),
            &direct_minimizer_terminal,
        ));
        assert!(steps_end_at_same_accepted_state(
            std::slice::from_ref(&direct_minimizer_terminal),
            &direct_minimizer_terminal,
        ));
    }

    #[test]
    fn cuda_field_snapshot_pool_exhaustion_drains_then_retries_once_at_same_clock() {
        let clock = ("H_eff", 271, 8.48105e-10, 1.0e-14);
        let order = std::cell::RefCell::new(Vec::new());
        let mut attempted_clocks = Vec::new();
        let mut attempts = 0;

        let snapshot = capture_cuda_field_snapshot_after_pool_drain(
            || {
                attempts += 1;
                attempted_clocks.push(clock);
                order.borrow_mut().push("capture");
                if attempts == 1 {
                    Err(RunError {
                        message: CUDA_FIELD_SNAPSHOT_POOL_EXHAUSTED.into(),
                    })
                } else {
                    Ok(clock)
                }
            },
            || {
                order.borrow_mut().push("drain");
                Ok(())
            },
        )
        .expect("retry should capture the same accepted state");

        assert_eq!(snapshot, clock);
        assert_eq!(attempts, 2);
        assert_eq!(attempted_clocks, vec![clock, clock]);
        assert_eq!(order.into_inner(), vec!["capture", "drain", "capture"]);
    }

    #[test]
    fn cuda_field_snapshot_does_not_drain_or_retry_for_success_or_other_errors() {
        let mut attempts = 0;
        let mut drains = 0;
        let snapshot = capture_cuda_field_snapshot_after_pool_drain(
            || {
                attempts += 1;
                Ok(42)
            },
            || {
                drains += 1;
                Ok(())
            },
        )
        .expect("initial capture should succeed");
        assert_eq!(snapshot, 42);
        assert_eq!(attempts, 1);
        assert_eq!(drains, 0);

        let mut attempts = 0;
        let error = capture_cuda_field_snapshot_after_pool_drain::<()>(
            || {
                attempts += 1;
                Err(RunError {
                    message: "unrelated native failure".into(),
                })
            },
            || {
                drains += 1;
                Ok(())
            },
        )
        .expect_err("unrelated failure should propagate");
        assert_eq!(error.message, "unrelated native failure");
        assert_eq!(attempts, 1);
        assert_eq!(drains, 0);
    }

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
    fn empty_schedule_emits_initial_only_for_default_scalar_trace() {
        let stats = StepStats {
            step: 0,
            time: 0.0,
            e_total: 4.0e-19,
            ..StepStats::default()
        };
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(
            crate::types::ExecutionProvenance::default(),
        );
        let mut no_schedules = Vec::new();

        record_cuda_initial_scalar(
            &FdmPlanIR::default(),
            &stats,
            false,
            &mut no_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("no unconfigured scalar output");
        assert!(steps.is_empty());

        record_cuda_initial_scalar(
            &FdmPlanIR::default(),
            &stats,
            true,
            &mut no_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("the existing default scalar trace includes the initial state");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].time, 0.0);
        assert_eq!(steps[0].e_total, 4.0e-19);
    }

    #[test]
    fn cuda_field_ledger_deduplicates_both_schedule_orders_and_keeps_terminal_clock() {
        let mut time_output_first = CudaFieldCaptureLedger::default();
        assert_eq!(
            time_output_first.uncaptured_names(vec!["m".into()], 100, 1.0e-12),
            vec!["m"]
        );
        time_output_first.mark_recorded("m", 100, 1.0e-12);
        assert!(
            time_output_first
                .uncaptured_names(vec!["m".into()], 100, 1.0e-12)
                .is_empty(),
            "step autosave must reuse the time-output frame"
        );

        let mut step_autosave_first = CudaFieldCaptureLedger::default();
        assert_eq!(
            step_autosave_first.uncaptured_names(vec!["m".into()], 100, 1.0e-12),
            vec!["m"]
        );
        step_autosave_first.mark_recorded("m", 100, 1.0e-12);
        assert!(
            step_autosave_first
                .uncaptured_names(vec!["m".into()], 100, 1.0e-12)
                .is_empty(),
            "the final time-output request must reuse the step-autosave frame"
        );

        let mut enqueue_retry = CudaFieldCaptureLedger::default();
        assert_eq!(
            enqueue_retry.uncaptured_names(vec!["m".into()], 100, 1.0e-12),
            vec!["m"]
        );
        assert_eq!(
            enqueue_retry.uncaptured_names(vec!["m".into()], 100, 1.0e-12),
            vec!["m"],
            "a failed enqueue does not mark the field as captured"
        );
        enqueue_retry.mark_recorded("m", 100, 1.0e-12);
        assert!(
            enqueue_retry
                .uncaptured_names(vec!["m".into()], 100, 1.0e-12)
                .is_empty()
        );

        let mut ledger = CudaFieldCaptureLedger::default();
        ledger.mark_recorded("m", 0, 0.0);
        assert_eq!(
            ledger.uncaptured_names(vec!["m".into()], 271, 1.0e-9),
            vec!["m"],
            "the BB/NCG terminal sample at step N differs from initial m0"
        );
        ledger.mark_recorded("m", 271, 1.0e-9);
        assert_eq!(ledger.last_capture_by_name.len(), 1);
    }

    #[test]
    fn merged_time_and_accepted_step_fields_are_deduplicated() {
        let mut requested = vec!["m".to_string()];
        append_unique_field_names(
            &mut requested,
            ["m".to_string(), "H_eff".to_string(), "H_eff".to_string()],
        );
        assert_eq!(requested, vec!["m", "H_eff"]);

        let no_output_ir_fields =
            crate::schedules::collect_field_schedules(&[]).expect("empty OutputIR is valid");
        assert!(no_output_ir_fields.is_empty());
        let mut requested_without_output_ir = no_output_ir_fields
            .into_iter()
            .map(|schedule| schedule.name)
            .collect::<Vec<_>>();
        append_unique_field_names(
            &mut requested_without_output_ir,
            ["m".to_string(), "H_eff".to_string()],
        );
        assert_eq!(requested_without_output_ir, vec!["m", "H_eff"]);
    }

    #[test]
    fn time_only_stream_has_no_accepted_step_autosave_schedule() {
        use crate::artifact_pipeline::ArtifactPipeline;
        use crate::artifacts::FieldArtifactContext;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-cuda-time-only-stream-{}-{unique}",
            std::process::id()
        ));
        let context = FieldArtifactContext {
            problem_name: "cuda-time-only-stream".into(),
            ir_version: "v0".into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fdm", "grid": [1, 1, 1]}),
            magnetization_field_semantics: Ok(None),
            execution_resolution: None,
        };
        let mut pipeline = ArtifactPipeline::start(output_dir.clone(), context, 2)
            .expect("start time-only writer");
        assert!(!pipeline.sender().has_accepted_step_autosave_schedules());

        pipeline.finish().expect("finish temporary pipeline");
        std::fs::remove_dir_all(output_dir).expect("remove temporary pipeline output");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn accepted_step_field_and_table_autosaves_use_only_actual_steps() {
        use crate::artifact_pipeline::ArtifactPipeline;
        use crate::artifacts::FieldArtifactContext;
        use fullmag_ir::{
            AutosaveFormatIR, AutosaveLayoutIR, BackendPlanIR, BackendTarget, CommonPlanMeta,
            ExecutionPlanIR, FieldAutosaveIR, OutputPlanIR, ProvenancePlanIR, StageAutosaveIR,
            TableAutosaveIR,
        };
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-cuda-step-fields-{}-{unique}",
            std::process::id()
        ));
        let mut problem: fullmag_ir::ProblemIR = serde_json::from_str(include_str!(
            "../../../../../../tests/standard_problems/transport/racetrack_m1_v1/python_problem_ir.v1.json"
        ))
        .expect("canonical ProblemIR fixture");
        problem.physics_graph = None;
        problem.study.sampling_mut().stage_autosave = Some(StageAutosaveIR {
            kind: "stage_autosave".into(),
            target: "state".into(),
            layout: AutosaveLayoutIR::Separate,
            format: AutosaveFormatIR::Zarr,
            table: Some(TableAutosaveIR {
                kind: "table_autosave".into(),
                table_id: "relaxation".into(),
                sample_period_s: None,
                sample_period_policy: None,
                resolved_sample_period_s: None,
                every_steps: Some(10),
                quantities: vec!["step".into(), "t".into(), "e_total".into()],
                expressions: Vec::new(),
            }),
            fields: vec![
                FieldAutosaveIR {
                    kind: "field_autosave".into(),
                    quantity: "m".into(),
                    every_seconds: None,
                    sample_period_policy: None,
                    every_steps: Some(100),
                },
                FieldAutosaveIR {
                    kind: "field_autosave".into(),
                    quantity: "H_eff".into(),
                    every_seconds: None,
                    sample_period_policy: None,
                    every_steps: Some(100_000),
                },
            ],
        });
        let plan = ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: problem.ir_version.clone(),
                requested_backend: BackendTarget::Fdm,
                resolved_backend: BackendTarget::Fdm,
                execution_mode: fullmag_ir::ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fdm(fullmag_ir::FdmPlanIR::default()),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR::default(),
        };
        let context = FieldArtifactContext {
            problem_name: "cuda-step-fields".into(),
            ir_version: problem.ir_version.clone(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fdm", "grid": [1, 1, 1]}),
            magnetization_field_semantics: Ok(None),
            execution_resolution: None,
        };
        let mut pipeline = ArtifactPipeline::start_for_problem_and_plan(
            &problem,
            &plan,
            output_dir.clone(),
            context,
            2,
        )
        .expect("start temporary stage-autosave pipeline");
        let sender = pipeline.sender();
        assert!(sender.has_accepted_step_autosave_schedules());
        let mut recorder = ArtifactRecorder::streaming(ExecutionProvenance::default(), sender);
        assert!(recorder.accepted_step_table_due(0));
        assert!(!recorder.accepted_step_table_due(9));
        assert!(recorder.accepted_step_table_due(10));
        assert!(!recorder.accepted_step_table_due(271));

        assert_eq!(
            recorder.due_accepted_step_fields(0, true),
            vec!["m", "H_eff"],
            "the initialized stage state is an explicit, real sample"
        );
        assert!(recorder.due_accepted_step_fields(0, false).is_empty());
        assert!(recorder.due_accepted_step_fields(99, false).is_empty());
        assert_eq!(recorder.due_accepted_step_fields(100, false), vec!["m"]);
        assert_eq!(recorder.due_accepted_step_fields(200, false), vec!["m"]);
        assert_eq!(
            recorder.due_accepted_step_fields(271, true),
            vec!["m", "H_eff"],
            "the actual terminal accepted step is emitted once even off cadence"
        );
        assert!(recorder.due_accepted_step_fields(271, true).is_empty());

        pipeline.finish().expect("finish temporary pipeline");
        std::fs::remove_dir_all(output_dir).expect("remove temporary pipeline output");
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
