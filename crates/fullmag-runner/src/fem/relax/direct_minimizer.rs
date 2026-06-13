//! FEM native step-based relaxation execution loop.
//!
//! This module owns runner orchestration for FEM native relaxation algorithms
//! that advance through the `fullmag_fem_backend_relax_step` ABI. The native
//! backend owns the actual algorithm step, including tangent gradients, line
//! search, field refresh, and magnetization updates.

use fullmag_ir::{FemPlanIR, RelaxationControlIR, StageCompletionIR, StageStopReason};

use crate::artifact_pipeline::ArtifactRecorder;
use crate::dispatch::flatten_vectors;
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::native_fem::NativeFemBackend;
use crate::relaxation::direct_minimizer::{
    direct_minimizer_pseudotime_budget, direct_minimizer_step_budget,
};
use crate::types::{FemMeshPayload, LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

use super::preview::build_fem_cached_preview_fields;
use super::scalars::ensure_fem_object_scalars;

pub(crate) struct DirectMinimizerExecution {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) backend_completion: Option<fullmag_ir::StageCompletionIR>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
}

pub(crate) fn execute_direct_minimizer(
    backend: &mut NativeFemBackend,
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
    let mut pseudotime_s = 0.0;

    while accepted_steps < direct_minimizer_step_budget(control)
        && pseudotime_s < direct_minimizer_pseudotime_budget(control)
    {
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
                    let preview_field = if preview_due && !preview_targets_global_scalar {
                        let request = display_selection.preview_request();
                        Some(backend.copy_live_preview_field(&request, node_count)?)
                    } else {
                        None
                    };
                    let cached_preview_fields = if preview_due {
                        build_fem_cached_preview_fields(
                            backend,
                            &display_selection,
                            plan,
                            node_count,
                        )
                    } else {
                        None
                    };
                    if current_stats.step <= 2 || preview_due {
                        eprintln!(
                            "[fullmag-runner] native-fem direct-minimizer live update step={} every_n={} preview_due={} preview_quantity={} preview_field={} cached_preview_fields={} global_scalar={} mag_len={}",
                            current_stats.step,
                            u64::from(display_selection.selection.every_n.max(1)),
                            preview_due,
                            display_selection.selection.quantity.as_str(),
                            preview_field.is_some(),
                            cached_preview_fields
                                .as_ref()
                                .map(|fields| fields.len())
                                .unwrap_or(0),
                            preview_targets_global_scalar,
                            node_count.saturating_mul(3),
                        );
                    }
                    let action = (live.on_step)(StepUpdate {
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh: Some(FemMeshPayload::from(plan)),
                        magnetization: Some(flatten_vectors(&backend.copy_m(node_count)?)),
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
        pseudotime_s += direct_minimizer_step_pseudotime_s(accepted_stats.dt);
        accepted_stats.pseudo_time_s = Some(pseudotime_s);
        ensure_fem_object_scalars(&mut accepted_stats, plan);

        artifacts.record_scalar(&accepted_stats)?;
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
            let magnetization = if current_stats.step % heavy_payload_every == 0 {
                Some(flatten_vectors(&backend.copy_m(node_count)?))
            } else {
                None
            };
            let preview_field = if preview_due && !preview_targets_global_scalar {
                let selection = display_selection.as_ref().expect("checked preview_due");
                let request = selection.preview_request();
                Some(backend.copy_live_preview_field(&request, node_count)?)
            } else {
                None
            };
            let cached_preview_fields = if preview_due {
                display_selection.as_ref().and_then(|selection| {
                    build_fem_cached_preview_fields(backend, selection, plan, node_count)
                })
            } else {
                None
            };
            if current_stats.step <= 2 || preview_due {
                eprintln!(
                    "[fullmag-runner] native-fem direct-minimizer live update step={} every_n={} preview_due={} preview_quantity={} preview_field={} cached_preview_fields={} global_scalar={} mag_len={}",
                    current_stats.step,
                    display_selection
                        .as_ref()
                        .map(|selection| u64::from(selection.selection.every_n.max(1)))
                        .unwrap_or(0),
                    preview_due,
                    display_selection
                        .as_ref()
                        .map(|selection| selection.selection.quantity.as_str())
                        .unwrap_or("-"),
                    preview_field.is_some(),
                    cached_preview_fields
                        .as_ref()
                        .map(|fields| fields.len())
                        .unwrap_or(0),
                    preview_targets_global_scalar,
                    magnetization
                        .as_ref()
                        .map(|values| values.len())
                        .unwrap_or(0),
                );
            }
            let action = (live.on_step)(StepUpdate {
                stats: current_stats.clone(),
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
        if let Some(completion) = infer_runner_pseudotime_completion(control, pseudotime_s) {
            backend_completion = Some(completion);
            break;
        }
    }

    Ok(DirectMinimizerExecution {
        latest_stats,
        backend_completion,
        cancelled,
        paused,
    })
}

fn direct_minimizer_step_pseudotime_s(dt: f64) -> f64 {
    if dt.is_finite() && dt > 0.0 {
        dt
    } else {
        0.0
    }
}

fn infer_runner_pseudotime_completion(
    control: &RelaxationControlIR,
    pseudotime_s: f64,
) -> Option<StageCompletionIR> {
    let threshold = control.stop.max_pseudotime_s?;
    if pseudotime_s < threshold {
        return None;
    }
    Some(StageCompletionIR {
        status: "completed".to_string(),
        reason: Some(StageStopReason::MaxPseudotime),
        metric_name: Some("pseudo_time_s".to_string()),
        metric_value: Some(pseudotime_s),
        threshold: Some(threshold),
    })
}

#[cfg(test)]
mod tests {
    use fullmag_ir::{RelaxStopIR, RelaxationAlgorithmIR, RelaxationControlIR, StageStopReason};

    #[test]
    fn direct_minimizer_publishes_live_update_after_accepted_step() {
        let source = include_str!("direct_minimizer.rs");
        assert!(
            source.contains("artifacts.record_scalar(&accepted_stats)?;")
                && source.contains("let magnetization = if current_stats.step % heavy_payload_every == 0")
                && source.contains("let action = (live.on_step)(StepUpdate {\n                stats: current_stats.clone(),"),
            "FEM direct minimizer must publish live stats/magnetization after accepted steps, not only the initial snapshot"
        );
    }

    #[test]
    fn direct_minimizer_runner_reports_max_pseudotime() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(100),
                max_pseudotime_s: Some(1e-6),
                max_physical_time_s: None,
            },
        };

        assert!(super::infer_runner_pseudotime_completion(&control, 9.0e-7).is_none());
        let completion = super::infer_runner_pseudotime_completion(&control, 1.2e-6)
            .expect("pseudotime threshold should complete the stage");

        assert_eq!(completion.reason, Some(StageStopReason::MaxPseudotime));
        assert_eq!(completion.metric_name.as_deref(), Some("pseudo_time_s"));
        assert_eq!(completion.metric_value, Some(1.2e-6));
        assert_eq!(completion.threshold, Some(1e-6));
    }
}
