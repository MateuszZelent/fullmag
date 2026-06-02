//! LLG overdamped relaxation specifics for FEM.
//!
//! The overdamped LLG is the primary production relaxation algorithm for FEM.
//! It reuses the standard LLG time-stepping pipeline with the precession term
//! disabled:
//!
//! ```text
//! dm/dt = -α γ_eff (m × H_eff) × m   [pure damping, no precession]
//! ```
//!
//! In the native ABI this translates to setting the `precession_enabled` flag
//! to `false`.  The integrator (Heun/RK4/RK23/RK45) and adaptive dt policy
//! are independent of this choice.

use fullmag_ir::{FemPlanIR, IntegratorChoice, RelaxationAlgorithmIR, RelaxationControlIR};

#[cfg(feature = "fem-gpu")]
use crate::artifact_pipeline::ArtifactRecorder;
#[cfg(feature = "fem-gpu")]
use crate::dispatch::{ensure_fem_object_scalars, flatten_vectors};
#[cfg(feature = "fem-gpu")]
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemBackend;
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(feature = "fem-gpu")]
use crate::relaxation::{relaxation_converged, RelaxationEnergyPlateauWindow};
use crate::types::ExecutionProvenance;
#[cfg(feature = "fem-gpu")]
use crate::types::{FemMeshPayload, LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

#[cfg(feature = "fem-gpu")]
use super::preview::build_fem_cached_preview_fields;

// ── Algorithm predicate ───────────────────────────────────────────────────────

/// Returns `true` if `plan` requests overdamped LLG (precession disabled).
///
/// Equivalent to checking `plan.relaxation.algorithm == LlgOverdamped`, but
/// goes through the shared helper in `relaxation.rs` so the logic is not
/// duplicated.
pub fn uses_pure_damping(plan: &FemPlanIR) -> bool {
    llg_overdamped_uses_pure_damping(plan.relaxation.as_ref())
}

/// Returns `true` when the plan represents any form of relaxation (not a
/// time-evolution stage).
pub fn is_relax_stage(plan: &FemPlanIR) -> bool {
    plan.relaxation.is_some()
}

// ── Recommended integrators ───────────────────────────────────────────────────

/// Returns the recommended default integrator for LLG overdamped FEM
/// relaxation given the user's damping parameter.
///
/// | α               | Recommended     | Rationale                              |
/// |-----------------|-----------------|----------------------------------------|
/// | < 0.1           | RK45            | precession residuals survive, need accuracy |
/// | 0.1 – 0.5       | RK45 or RK23    | balanced; RK45 preferred               |
/// | > 0.5           | Heun or RK23    | fast convergence, step cost matters    |
pub fn recommended_integrator(damping: f64) -> IntegratorChoice {
    if damping > 0.5 {
        IntegratorChoice::Heun
    } else {
        IntegratorChoice::Rk45
    }
}

// ── Provenance helpers ────────────────────────────────────────────────────────

/// Fills `provenance` with overdamped LLG algorithm fields.
///
/// Called after the stage is dispatched to the backend so that the resolved
/// fields (integrator, dt policy, precession flag) are recorded correctly.
pub fn fill_provenance(provenance: &mut ExecutionProvenance, plan: &FemPlanIR) {
    let pure_damping = uses_pure_damping(plan);
    let integrator_label = match plan.integrator {
        IntegratorChoice::Heun => "heun",
        IntegratorChoice::Rk4 => "rk4",
        IntegratorChoice::Rk23 => "rk23",
        IntegratorChoice::Rk45 => "rk45",
        IntegratorChoice::Abm3 => "abm3",
    };

    provenance.requested_integrator = Some(integrator_label.to_string());
    provenance.resolved_integrator = Some(integrator_label.to_string());

    // Record whether precession was suppressed.
    if pure_damping {
        provenance.requested_energy_minimizer = Some("llg_overdamped".to_string());
        provenance.resolved_energy_minimizer = Some("llg_overdamped".to_string());
    }
}

// ── LLG overdamped mode description ──────────────────────────────────────────

/// Returns a log-level string describing how the LLG is configured.
///
/// Used in runtime startup messages (mirrors `native_fem_llg_mode` in
/// `dispatch.rs` but scoped to this module).
pub fn llg_mode_label(plan: &FemPlanIR) -> &'static str {
    match (uses_pure_damping(plan), plan.relaxation.as_ref()) {
        (true, _) => "overdamped (precession disabled)",
        (false, Some(ctrl)) if ctrl.algorithm == RelaxationAlgorithmIR::LlgOverdamped => {
            "llg_overdamped with precession (high damping not set)"
        }
        _ => "full LLG (precession + damping)",
    }
}

// ── Stop-criteria summary ─────────────────────────────────────────────────────

/// Produces a human-readable summary of the active stop criteria for an
/// overdamped LLG stage.  Used in startup log messages.
pub fn stop_summary(control: &RelaxationControlIR) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = control.stop.torque_tolerance_apm {
        parts.push(format!("torque ≤ {:.2e} A/m", t));
    }
    if let Some(e) = control.stop.energy_tolerance_j {
        parts.push(format!("ΔE_50steps ≤ {:.2e} J", e));
    }
    if let Some(s) = control.stop.max_steps {
        parts.push(format!("max_steps = {}", s));
    }
    if let Some(t) = control.stop.max_pseudotime_s {
        parts.push(format!("max_pseudotime = {:.3e} s", t));
    }
    if parts.is_empty() {
        "no stop criteria (runs until cancelled)".to_string()
    } else {
        parts.join(", ")
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) struct LlgOverdampedExecution {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) backend_completion: Option<fullmag_ir::StageCompletionIR>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn execute_llg_overdamped(
    backend: &mut NativeFemBackend,
    plan: &FemPlanIR,
    until_seconds: f64,
    node_count: usize,
    mut dt: f64,
    dt_is_fixed: bool,
    mut current_stats: StepStats,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: &mut ArtifactRecorder,
    steps: &mut Vec<StepStats>,
    energy_plateau: &mut RelaxationEnergyPlateauWindow,
    mut last_preview_revision: Option<u64>,
) -> Result<LlgOverdampedExecution, RunError> {
    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = 0.0;
    let mut backend_completion: Option<fullmag_ir::StageCompletionIR> = None;
    let mut cancelled = false;
    let mut paused = false;
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());

    let until_label = if until_seconds.is_finite() {
        format!("{until_seconds:.4e}")
    } else {
        "unbounded".to_string()
    };
    eprintln!(
        "[fullmag-runner] native-fem LLG loop: until={} dt_initial={:.4e} \
         max_steps={} torque_tol_Apm={:.4e} torque_tol_T={:.4e} adaptive={}",
        until_label,
        dt,
        plan.relaxation
            .as_ref()
            .and_then(|control| control.stop.max_steps)
            .unwrap_or(0),
        plan.relaxation
            .as_ref()
            .and_then(|control| control.stop.torque_tolerance_apm)
            .unwrap_or(0.0),
        plan.relaxation
            .as_ref()
            .and_then(|control| control.stop.torque_tolerance_apm)
            .map(|value| value * crate::MU0)
            .unwrap_or(0.0),
        !dt_is_fixed,
    );

    while current_time < until_seconds {
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
                    let action = (live.on_step)(StepUpdate {
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh: (current_stats.step == 0).then_some(FemMeshPayload::from(plan)),
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
        let dt_step = dt.min(until_seconds - current_time);
        let interrupt_requested = live
            .as_ref()
            .and_then(|consumer| consumer.interrupt_requested);
        let Some(mut stats) = backend.step_interruptible(dt_step, interrupt_requested)? else {
            continue;
        };
        ensure_fem_object_scalars(&mut stats, plan);
        current_time = stats.time;
        if !dt_is_fixed {
            if let Some(s) = stats.dt_suggested {
                dt = s;
            } else if stats.dt > 0.0 {
                dt = stats.dt;
            }
        }
        latest_stats = Some(stats.clone());
        current_stats = stats.clone();
        if let Some(live) = live.as_mut() {
            let heavy_payload_every = live.field_every_n.max(1);
            let display_selection = live.display_selection.map(|get| get());
            let preview_due = display_selection
                .as_ref()
                .map(|selection| display_refresh_due(last_preview_revision, selection, stats.step))
                .unwrap_or(false);
            let preview_targets_global_scalar = display_selection
                .as_ref()
                .is_some_and(display_is_global_scalar);
            let magnetization = if stats.step % heavy_payload_every == 0 {
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
            if stats.step <= 2 || preview_due {
                eprintln!(
                    "[fullmag-runner] native-fem live update step={} every_n={} preview_due={} preview_quantity={} preview_field={} cached_preview_fields={} global_scalar={} mag_len={}",
                    stats.step,
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
                    magnetization.as_ref().map(|values| values.len()).unwrap_or(0),
                );
            }
            let action = (live.on_step)(StepUpdate {
                stats: stats.clone(),
                grid: live.grid,
                fem_mesh: Some(FemMeshPayload::from(plan)),
                magnetization,
                preview_field,
                cached_preview_fields,
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
        if cancelled || paused {
            break;
        }

        artifacts.record_scalar(&stats)?;
        steps.push(stats);

        let latest = steps.last().expect("just pushed stats");
        let energy_plateau_range = energy_plateau.record(latest.e_total);
        let stop_for_relaxation = if let Some(control) = plan.relaxation.as_ref() {
            if let Some(completion) = backend.stage_completion()? {
                backend_completion = Some(completion);
                true
            } else {
                let max_steps_hit = latest.step >= control.stop.max_steps.unwrap_or(u64::MAX);
                let converged = relaxation_converged(
                    control,
                    latest,
                    energy_plateau_range,
                    plan.gyromagnetic_ratio,
                    plan.material.damping,
                    pure_damping_relax,
                );
                if max_steps_hit || converged {
                    eprintln!(
                        "[fullmag-runner] native-fem relaxation stop at step {}: \
                         max_steps_hit={max_steps_hit} (step={} >= max_steps={}), \
                         converged={converged} \
                         (max_torque_T={:.4e} torque_tol_Apm={} torque_tol_T={} energy_tol={})",
                        latest.step,
                        latest.step,
                        control
                            .stop
                            .max_steps
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "none".to_string()),
                        latest.max_torque_T,
                        control
                            .stop
                            .torque_tolerance_apm
                            .map(|value| format!("{value:.4e}"))
                            .unwrap_or_else(|| "none".to_string()),
                        control
                            .stop
                            .torque_tolerance_apm
                            .map(|value| format!("{:.4e}", value * crate::MU0))
                            .unwrap_or_else(|| "none".to_string()),
                        control
                            .stop
                            .energy_tolerance_j
                            .map(|value| format!("{value:.4e}"))
                            .unwrap_or_else(|| "none".to_string()),
                    );
                }
                max_steps_hit || converged
            }
        } else {
            false
        };
        if stop_for_relaxation {
            break;
        }
    }
    if !cancelled {
        let until_label = if until_seconds.is_finite() {
            format!("{until_seconds:.4e}")
        } else {
            "unbounded".to_string()
        };
        eprintln!(
            "[fullmag-runner] native-fem loop exited: time={:.4e} until={} (time_limit_reached={})",
            current_time,
            until_label,
            current_time >= until_seconds,
        );
    }

    Ok(LlgOverdampedExecution {
        latest_stats,
        backend_completion,
        cancelled,
        paused,
    })
}
