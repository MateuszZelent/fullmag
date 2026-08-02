//! FEM native step-based relaxation execution loop.
//!
//! This module owns runner orchestration for FEM native relaxation algorithms
//! that advance through the `fullmag_fem_backend_relax_step` ABI. The native
//! backend owns the actual algorithm step, including tangent gradients, line
//! search, field refresh, and magnetization updates.

use fullmag_ir::{FemPlanIR, RelaxationControlIR, StageCompletionIR};

use crate::artifact_pipeline::{apply_artifact_enqueue_metrics, ArtifactRecorder};
use crate::dispatch::FemEngine;
use crate::interactive_runtime::{
    cached_display_refresh_due, display_is_global_scalar, display_refresh_due,
};
use crate::native_fem::NativeFemBackend;
use crate::relaxation::direct_minimizer::direct_minimizer_step_budget;
use crate::relaxation::{resolve_stage_completion, RelaxationCompletionMetrics};
use crate::solver_profile::{current_thread_cpu_time_ns, elapsed_current_thread_cpu_ns};
use crate::types::{LiveStepConsumer, RunError, RunStatus, StepAction, StepStats, StepUpdate};

use super::preview::FemPreviewHandoff;
use super::scalars::ensure_fem_object_scalars;

pub(crate) struct DirectMinimizerExecution {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) terminal_stats: Option<StepStats>,
    pub(crate) backend_completion: Option<fullmag_ir::StageCompletionIR>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
    pub(crate) preview_handoff: FemPreviewHandoff,
}

pub(crate) fn execute_direct_minimizer(
    backend: &mut NativeFemBackend,
    engine: FemEngine,
    plan: &FemPlanIR,
    fem_mesh_generation_id: &Option<String>,
    node_count: usize,
    control: &RelaxationControlIR,
    mut current_stats: StepStats,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: &mut ArtifactRecorder,
    steps: &mut Vec<StepStats>,
    mut last_preview_revision: Option<u64>,
) -> Result<DirectMinimizerExecution, RunError> {
    let mut latest_stats: Option<StepStats> = None;
    let mut terminal_stats: Option<StepStats> = None;
    let mut backend_completion: Option<StageCompletionIR> = None;
    let mut cancelled = false;
    let mut paused = false;
    let mut accepted_steps = 0u64;
    let mut last_cached_preview_revision = last_preview_revision;
    let mut preview_handoff = FemPreviewHandoff::default();

    while accepted_steps < direct_minimizer_step_budget(control) {
        if live
            .as_ref()
            .is_some_and(|consumer| consumer.initial_snapshot)
        {
            if let Some(live) = live.as_mut() {
                if let Some(display_selection) = live.display_selection.map(|get| get()) {
                    let preview_due = display_refresh_due(
                        last_preview_revision,
                        &display_selection,
                        current_stats.step,
                    );
                    let preview_targets_global_scalar =
                        display_is_global_scalar(&display_selection);
                    let mut live_stats = current_stats.clone();
                    let preview_callback_cpu_started = current_thread_cpu_time_ns();
                    preview_handoff.reset_timings();
                    let preview_start = std::time::Instant::now();
                    let preview_field = if preview_due && !preview_targets_global_scalar {
                        let request = display_selection.preview_request();
                        preview_handoff.request_preview(
                            backend,
                            &request,
                            node_count,
                            current_stats.step,
                            current_stats.time,
                            current_stats.dt,
                        )?
                    } else {
                        preview_handoff.poll_active()?
                    };
                    live_stats.preview_wall_time_ns = preview_start.elapsed().as_nanos() as u64;
                    let cached_preview_due = cached_display_refresh_due(
                        last_cached_preview_revision,
                        &display_selection,
                        current_stats.step,
                        live.field_every_n,
                    );
                    let cached_start = std::time::Instant::now();
                    let cached_preview_fields = if cached_preview_due {
                        preview_handoff.request_cached_previews(
                            backend,
                            engine,
                            &display_selection,
                            plan,
                            node_count,
                            current_stats.step,
                            current_stats.time,
                            current_stats.dt,
                        )?
                    } else {
                        preview_handoff.poll_cached(
                            backend,
                            node_count,
                            current_stats.step,
                            current_stats.time,
                            current_stats.dt,
                        )?
                    };
                    let magnetization_payload =
                        preview_handoff.request_magnetization(node_count, current_stats.step)?;
                    preview_handoff.dispatch_staged(backend);
                    live_stats.preview_superseded_count = preview_handoff.take_superseded_count();
                    live_stats.field_materialization_states =
                        preview_handoff.materialization_states();
                    preview_handoff.take_timings().record_into(&mut live_stats);
                    live_stats.cached_preview_wall_time_ns =
                        cached_start.elapsed().as_nanos() as u64;
                    let live_preview_wall_time_ns = live_stats
                        .preview_wall_time_ns
                        .saturating_add(live_stats.cached_preview_wall_time_ns);
                    let field_copy_wall_time_ns = magnetization_payload
                        .as_ref()
                        .map_or(0, |payload| payload.materialization_wall_time_ns);
                    let field_copy_bytes = magnetization_payload
                        .as_ref()
                        .map_or(0, |payload| payload.field_copy_bytes);
                    let magnetization = magnetization_payload.map(|payload| {
                        live_stats.magnetization_source_step = Some(payload.source_step);
                        live_stats.magnetization_source_revision = Some(payload.source_revision);
                        live_stats.magnetization_materialized_at_unix_ms =
                            Some(payload.materialized_at_unix_ms);
                        live_stats.magnetization_materialization_wall_time_ns =
                            Some(payload.materialization_wall_time_ns);
                        payload.values
                    });
                    live_stats.field_copy_wall_time_ns = live_stats
                        .field_copy_wall_time_ns
                        .saturating_add(field_copy_wall_time_ns);
                    live_stats.field_copy_bytes =
                        live_stats.field_copy_bytes.saturating_add(field_copy_bytes);
                    live_stats.wall_time_ns = live_stats
                        .wall_time_ns
                        .saturating_add(live_preview_wall_time_ns)
                        .saturating_add(field_copy_wall_time_ns);
                    live_stats.preview_callback_thread_cpu_time_ns =
                        elapsed_current_thread_cpu_ns(preview_callback_cpu_started);
                    live_stats.preview_callback_thread_cpu_started_ns =
                        preview_callback_cpu_started;
                    let action = (live.on_step)(StepUpdate {
                        stats: live_stats,
                        grid: live.grid,
                        fem_mesh_generation_id: fem_mesh_generation_id.clone(),
                        magnetization,
                        preview_field,
                        cached_preview_fields,
                        hysteresis_field_m_t: None,
                        hysteresis_point_index: None,
                        hysteresis_settle_step_index: None,
                        hysteresis_settle_step_kind: None,
                        hysteresis_settle_step_method: None,
                        scalar_row_due: preview_due && preview_targets_global_scalar,
                        finished: false,
                    });
                    if preview_due {
                        last_preview_revision = Some(display_selection.revision);
                    }
                    if cached_preview_due {
                        last_cached_preview_revision = Some(display_selection.revision);
                    }
                    match action {
                        StepAction::Continue => {}
                        StepAction::Stop => {
                            cancelled = true;
                            break;
                        }
                        StepAction::Pause => {
                            paused = true;
                            break;
                        }
                    }
                }
            }
        }

        let preview_schedule_fence_wall_time_ns = preview_handoff.flush_schedule_fence();
        if paused {
            break;
        }

        let Some(mut accepted_stats) = backend.relax_step(control.algorithm, node_count)? else {
            backend_completion = backend.stage_completion()?;
            cancelled = backend_completion.is_none();
            break;
        };
        accepted_stats.preview_schedule_fence_wall_time_ns = preview_schedule_fence_wall_time_ns;
        accepted_stats.wall_time_ns = accepted_stats
            .wall_time_ns
            .saturating_add(preview_schedule_fence_wall_time_ns);

        // Native PG-BB/NCG may return a torque-confirmation observation at
        // the current state without accepting a new line-search step.  Keep
        // that terminal state for final artifacts, but do not count it or
        // publish it as an accepted solver step.
        if accepted_stats.step <= current_stats.step {
            latest_stats = Some(accepted_stats.clone());
            terminal_stats = Some(accepted_stats.clone());
            current_stats = accepted_stats;
            if let Some(completion) = backend.stage_completion()? {
                backend_completion = Some(completion);
                break;
            }
            continue;
        }

        accepted_steps += 1;
        terminal_stats = None;
        ensure_fem_object_scalars(&mut accepted_stats, plan);

        let artifact_metrics = artifacts.record_scalar(&accepted_stats)?;
        apply_artifact_enqueue_metrics(&mut accepted_stats, artifact_metrics);
        for name in artifacts.due_accepted_step_fields(accepted_stats.step, false) {
            let snapshot = backend.begin_field_snapshot(
                &name,
                accepted_stats.step,
                accepted_stats.time,
                accepted_stats.dt,
            )?;
            let artifact_metrics = artifacts.record_native_fem_field_snapshot(snapshot)?;
            apply_artifact_enqueue_metrics(&mut accepted_stats, artifact_metrics);
        }
        steps.push(accepted_stats.clone());
        latest_stats = Some(accepted_stats.clone());
        current_stats = accepted_stats;

        if let Some(live) = live.as_mut() {
            let heavy_payload_every = live.field_every_n.max(1);
            let display_selection = live.display_selection.map(|get| get());
            let preview_due = display_selection
                .as_ref()
                .map(|selection| {
                    display_refresh_due(last_preview_revision, selection, current_stats.step)
                })
                .unwrap_or(false);
            let preview_targets_global_scalar = display_selection
                .as_ref()
                .is_some_and(display_is_global_scalar);
            let mut live_stats = current_stats.clone();
            let preview_callback_cpu_started = current_thread_cpu_time_ns();
            preview_handoff.reset_timings();
            let preview_start = std::time::Instant::now();
            let magnetization = if current_stats.step % heavy_payload_every == 0 {
                preview_handoff.request_magnetization(node_count, current_stats.step)?
            } else {
                preview_handoff.poll_magnetization()?
            };
            let magnetization = if let Some(payload) = magnetization {
                live_stats.field_copy_wall_time_ns = live_stats
                    .field_copy_wall_time_ns
                    .saturating_add(payload.materialization_wall_time_ns);
                live_stats.field_copy_bytes = live_stats
                    .field_copy_bytes
                    .saturating_add(payload.field_copy_bytes);
                live_stats.magnetization_source_step = Some(payload.source_step);
                live_stats.magnetization_source_revision = Some(payload.source_revision);
                live_stats.magnetization_materialized_at_unix_ms =
                    Some(payload.materialized_at_unix_ms);
                live_stats.magnetization_materialization_wall_time_ns =
                    Some(payload.materialization_wall_time_ns);
                Some(payload.values)
            } else {
                None
            };
            let preview_field = if preview_due && !preview_targets_global_scalar {
                let selection = display_selection.as_ref().expect("checked preview_due");
                let request = selection.preview_request();
                preview_handoff.request_preview(
                    backend,
                    &request,
                    node_count,
                    current_stats.step,
                    current_stats.time,
                    current_stats.dt,
                )?
            } else {
                preview_handoff.poll_active()?
            };
            live_stats.preview_wall_time_ns = preview_start.elapsed().as_nanos() as u64;
            let cached_preview_due = display_selection
                .as_ref()
                .map(|selection| {
                    cached_display_refresh_due(
                        last_cached_preview_revision,
                        selection,
                        current_stats.step,
                        heavy_payload_every,
                    )
                })
                .unwrap_or(false);
            let cached_start = std::time::Instant::now();
            let cached_preview_fields = if cached_preview_due {
                match display_selection.as_ref() {
                    Some(selection) => preview_handoff.request_cached_previews(
                        backend,
                        engine,
                        selection,
                        plan,
                        node_count,
                        current_stats.step,
                        current_stats.time,
                        current_stats.dt,
                    )?,
                    None => preview_handoff.poll_cached(
                        backend,
                        node_count,
                        current_stats.step,
                        current_stats.time,
                        current_stats.dt,
                    )?,
                }
            } else {
                preview_handoff.poll_cached(
                    backend,
                    node_count,
                    current_stats.step,
                    current_stats.time,
                    current_stats.dt,
                )?
            };
            preview_handoff.dispatch_staged(backend);
            live_stats.preview_superseded_count = preview_handoff.take_superseded_count();
            live_stats.field_materialization_states = preview_handoff.materialization_states();
            preview_handoff.take_timings().record_into(&mut live_stats);
            live_stats.cached_preview_wall_time_ns = cached_start.elapsed().as_nanos() as u64;
            let live_preview_wall_time_ns = live_stats
                .preview_wall_time_ns
                .saturating_add(live_stats.cached_preview_wall_time_ns);
            live_stats.wall_time_ns = live_stats
                .wall_time_ns
                .saturating_add(live_preview_wall_time_ns)
                .saturating_add(live_stats.field_copy_wall_time_ns);
            live_stats.preview_callback_thread_cpu_time_ns =
                elapsed_current_thread_cpu_ns(preview_callback_cpu_started);
            live_stats.preview_callback_thread_cpu_started_ns = preview_callback_cpu_started;
            let action = (live.on_step)(StepUpdate {
                stats: live_stats,
                grid: live.grid,
                fem_mesh_generation_id: fem_mesh_generation_id.clone(),
                magnetization,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && preview_targets_global_scalar,
                finished: false,
            });
            if preview_due {
                last_preview_revision = Some(
                    display_selection
                        .as_ref()
                        .expect("checked preview_due")
                        .revision,
                );
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(
                    display_selection
                        .as_ref()
                        .map(|selection| selection.revision)
                        .unwrap_or_default(),
                );
            }
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

        if cancelled {
            break;
        }

        if let Some(completion) = backend.stage_completion()? {
            backend_completion = Some(completion);
            break;
        }
    }

    if backend_completion.is_none() && !cancelled && !paused {
        backend_completion = Some(resolve_stage_completion(
            RunStatus::Completed,
            Some(control),
            RelaxationCompletionMetrics {
                steps: accepted_steps,
                ..RelaxationCompletionMetrics::default()
            },
        ));
    }

    Ok(DirectMinimizerExecution {
        latest_stats,
        terminal_stats,
        backend_completion,
        cancelled,
        paused,
        preview_handoff,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn direct_minimizer_publishes_live_update_after_accepted_step() {
        let source = include_str!("direct_minimizer.rs");
        assert!(
            source.contains("artifacts.record_scalar(&accepted_stats)?;")
                && source.contains("let magnetization = if current_stats.step % heavy_payload_every == 0")
                && source.contains("current_stats = accepted_stats;\n\n        if let Some(live) = live.as_mut() {")
                && source.contains("live_stats.field_copy_bytes =\n                        live_stats.field_copy_bytes.saturating_add(field_copy_bytes);")
                && source.contains("live_stats.wall_time_ns = live_stats")
                && source.contains("let action = (live.on_step)(StepUpdate {\n                stats: live_stats,"),
            "FEM direct minimizer must publish accepted-step live stats/magnetization with cadence and timing/copy metrics"
        );
    }

    #[test]
    fn direct_minimizer_is_step_bounded_and_uses_explicit_completion_metrics() {
        let source = include_str!("direct_minimizer.rs");

        assert!(!source.contains(concat!("pseudo", "time")));
        assert!(!source.contains(concat!("max_pseudo", "time_s")));
        assert!(source.contains("direct_minimizer_step_budget(control)"));
        assert!(source.contains("RelaxationCompletionMetrics"));
        assert!(source.contains("resolve_stage_completion"));
        assert!(source.contains("..RelaxationCompletionMetrics::default()"));
    }

    #[test]
    fn direct_minimizer_does_not_record_a_stationary_non_step_as_accepted() {
        let source = include_str!("direct_minimizer.rs");
        let no_step_branch = source
            .find("let Some(mut accepted_stats) = backend.relax_step")
            .expect("direct minimizer must branch on whether the native step was accepted");
        let accepted_step_increment = source
            .find("accepted_steps += 1;")
            .expect("direct minimizer must count accepted steps");

        assert!(no_step_branch < accepted_step_increment);
        assert!(source[no_step_branch..accepted_step_increment]
            .contains("backend_completion = backend.stage_completion()?;"));
        assert!(source[no_step_branch..accepted_step_increment]
            .contains("cancelled = backend_completion.is_none();"));
        assert!(
            !source[no_step_branch..accepted_step_increment].contains("artifacts.record_scalar")
        );
        assert!(!source[no_step_branch..accepted_step_increment].contains("steps.push"));
        assert!(source.contains("accepted_stats.step <= current_stats.step"));
        assert!(source.contains("continue;"));
    }
}
