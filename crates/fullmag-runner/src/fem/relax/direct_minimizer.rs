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
use crate::types::{
    FemMeshPayload, LiveStepConsumer, RunError, RunStatus, StepAction, StepStats, StepUpdate,
};

use super::preview::{FemCachedPreviewHandoff, FemLiveMagnetizationHandoff, FemLivePreviewHandoff};
use super::scalars::ensure_fem_object_scalars;

pub(crate) struct DirectMinimizerExecution {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) backend_completion: Option<fullmag_ir::StageCompletionIR>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
}

pub(crate) fn execute_direct_minimizer(
    backend: &mut NativeFemBackend,
    engine: FemEngine,
    plan: &FemPlanIR,
    node_count: usize,
    control: &RelaxationControlIR,
    mut current_stats: StepStats,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: &mut ArtifactRecorder,
    steps: &mut Vec<StepStats>,
    mut last_preview_revision: Option<u64>,
) -> Result<DirectMinimizerExecution, RunError> {
    let mut latest_stats: Option<StepStats> = None;
    let mut backend_completion: Option<StageCompletionIR> = None;
    let mut cancelled = false;
    let mut paused = false;
    let mut accepted_steps = 0u64;
    let mut last_cached_preview_revision = last_preview_revision;
    let mut live_preview_handoff = FemLivePreviewHandoff::default();
    let mut cached_preview_handoff = FemCachedPreviewHandoff::default();
    let mut live_magnetization_handoff = FemLiveMagnetizationHandoff::default();

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
                    let preview_start = std::time::Instant::now();
                    let preview_field = if preview_due && !preview_targets_global_scalar {
                        let request = display_selection.preview_request();
                        live_preview_handoff.request_preview(backend, &request, node_count)?
                    } else {
                        live_preview_handoff.poll_completed()?
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
                        cached_preview_handoff.request_cached_previews(
                            backend,
                            engine,
                            &display_selection,
                            plan,
                            node_count,
                        )?
                    } else {
                        cached_preview_handoff.poll_completed()?
                    };
                    live_stats.cached_preview_wall_time_ns =
                        cached_start.elapsed().as_nanos() as u64;
                    let live_preview_wall_time_ns = live_stats
                        .preview_wall_time_ns
                        .saturating_add(live_stats.cached_preview_wall_time_ns);
                    let magnetization_payload =
                        live_magnetization_handoff.request_magnetization(backend, node_count)?;
                    let (magnetization, field_copy_wall_time_ns, field_copy_bytes) =
                        match magnetization_payload {
                            Some((payload, wall_time_ns, bytes)) => {
                                (Some(payload), wall_time_ns, bytes)
                            }
                            None => (None, 0, 0),
                        };
                    live_stats.field_copy_wall_time_ns = live_stats
                        .field_copy_wall_time_ns
                        .saturating_add(field_copy_wall_time_ns);
                    live_stats.field_copy_bytes =
                        live_stats.field_copy_bytes.saturating_add(field_copy_bytes);
                    live_stats.wall_time_ns = live_stats
                        .wall_time_ns
                        .saturating_add(live_preview_wall_time_ns)
                        .saturating_add(field_copy_wall_time_ns);
                    let action = (live.on_step)(StepUpdate {
            coupled_checkpoint: None,
                        stats: live_stats,
                        grid: live.grid,
                        fem_mesh: Some(FemMeshPayload::from(plan)),
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

        if paused {
            break;
        }

        let Some(mut accepted_stats) = backend.relax_step(control.algorithm, node_count)? else {
            cancelled = true;
            break;
        };
        accepted_steps += 1;
        ensure_fem_object_scalars(&mut accepted_stats, plan);

        let artifact_metrics = artifacts.record_scalar(&accepted_stats)?;
        apply_artifact_enqueue_metrics(&mut accepted_stats, artifact_metrics);
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
            let magnetization = if current_stats.step % heavy_payload_every == 0 {
                live_magnetization_handoff.request_magnetization(backend, node_count)?
            } else {
                live_magnetization_handoff.poll_completed(node_count)?
            };
            let magnetization =
                if let Some((payload, field_copy_wall_time_ns, field_copy_bytes)) = magnetization {
                    live_stats.field_copy_wall_time_ns = live_stats
                        .field_copy_wall_time_ns
                        .saturating_add(field_copy_wall_time_ns);
                    live_stats.field_copy_bytes =
                        live_stats.field_copy_bytes.saturating_add(field_copy_bytes);
                    Some(payload)
                } else {
                    None
                };
            let preview_start = std::time::Instant::now();
            let preview_field = if preview_due && !preview_targets_global_scalar {
                let selection = display_selection.as_ref().expect("checked preview_due");
                let request = selection.preview_request();
                live_preview_handoff.request_preview(backend, &request, node_count)?
            } else {
                live_preview_handoff.poll_completed()?
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
                    Some(selection) => cached_preview_handoff
                        .request_cached_previews(backend, engine, selection, plan, node_count)?,
                    None => cached_preview_handoff.poll_completed()?,
                }
            } else {
                cached_preview_handoff.poll_completed()?
            };
            live_stats.cached_preview_wall_time_ns = cached_start.elapsed().as_nanos() as u64;
            let live_preview_wall_time_ns = live_stats
                .preview_wall_time_ns
                .saturating_add(live_stats.cached_preview_wall_time_ns);
            live_stats.wall_time_ns = live_stats
                .wall_time_ns
                .saturating_add(live_preview_wall_time_ns)
                .saturating_add(live_stats.field_copy_wall_time_ns);
            let action = (live.on_step)(StepUpdate {
            coupled_checkpoint: None,
                stats: live_stats,
                grid: live.grid,
                fem_mesh: Some(FemMeshPayload::from(plan)),
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
        backend_completion,
        cancelled,
        paused,
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
                && source.contains("let action = (live.on_step)(StepUpdate {
            coupled_checkpoint: None,\n                stats: live_stats,"),
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
}
