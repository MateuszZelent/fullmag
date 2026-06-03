//! FEM native step-based relaxation execution loop.
//!
//! This module owns runner orchestration for FEM native relaxation algorithms
//! that advance through the `fullmag_fem_backend_relax_step` ABI. The native
//! backend owns the actual algorithm step, including tangent gradients, line
//! search, field refresh, and magnetization updates.

use fullmag_ir::{FemPlanIR, RelaxationControlIR};

use crate::artifact_pipeline::ArtifactRecorder;
use crate::dispatch::flatten_vectors;
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::native_fem::NativeFemBackend;
use crate::relaxation::direct_minimizer::direct_minimizer_step_budget;
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
    let mut backend_completion: Option<fullmag_ir::StageCompletionIR> = None;
    let mut cancelled = false;
    let mut paused = false;
    let mut accepted_steps = 0u64;

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
        ensure_fem_object_scalars(&mut accepted_stats, plan);

        artifacts.record_scalar(&accepted_stats)?;
        steps.push(accepted_stats.clone());
        latest_stats = Some(accepted_stats.clone());
        current_stats = accepted_stats;

        if cancelled {
            break;
        }

        if let Some(completion) = backend.stage_completion()? {
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
