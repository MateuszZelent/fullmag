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
use crate::artifact_pipeline::{apply_artifact_enqueue_metrics, ArtifactRecorder};
#[cfg(feature = "fem-gpu")]
use crate::dispatch::FemEngine;
#[cfg(feature = "fem-gpu")]
use crate::interactive_runtime::{
    cached_display_refresh_due, display_is_global_scalar, display_refresh_due,
};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemBackend;
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(feature = "fem-gpu")]
use crate::relaxation::{RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation};
#[cfg(feature = "fem-gpu")]
use crate::schedules::{advance_due_schedules, is_due, OutputSchedule};
#[cfg(feature = "fem-gpu")]
use crate::solver_profile::{current_thread_cpu_time_ns, elapsed_current_thread_cpu_ns};
use crate::types::{ExecutionProvenance, RelaxationControllerPolicyProvenance};
#[cfg(feature = "fem-gpu")]
use crate::types::{FieldSnapshot, LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

#[cfg(feature = "fem-gpu")]
use super::preview::FemPreviewHandoff;
#[cfg(feature = "fem-gpu")]
use super::scalars::ensure_fem_object_scalars;

fn convergence_controller_policy() -> RelaxationControllerPolicyProvenance {
    RelaxationControllerPolicyProvenance {
        policy_id: "relaxation_convergence_v1".to_string(),
        torque_confirmation_samples: 3,
        energy_increase_relative_tolerance: 1.0e-10,
        energy_increase_absolute_tolerance_j: 1.0e-30,
        tightening_factor: std::f64::consts::FRAC_1_SQRT_2,
        max_error_floor: 1.0e-9,
    }
}

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
    let Some(integrator) = plan.integrator else {
        provenance.requested_integrator = None;
        provenance.resolved_integrator = None;
        return;
    };
    let integrator_label = match integrator {
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
        if let Some(timestep_policy) = provenance.timestep_policy.as_mut() {
            timestep_policy.relaxation_controller = Some(convergence_controller_policy());
        }
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
    if let Some(t) = control.stop.max_relaxation_time_s {
        parts.push(format!("max_relaxation_time = {:.3e} s", t));
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
    pub(crate) preview_handoff: FemPreviewHandoff,
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn execute_llg_overdamped(
    backend: &mut NativeFemBackend,
    engine: FemEngine,
    plan: &FemPlanIR,
    fem_mesh_generation_id: &Option<String>,
    until_seconds: f64,
    time_event_schedule_s: &[f64],
    node_count: usize,
    mut dt: f64,
    dt_is_fixed: bool,
    mut current_stats: StepStats,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: &mut ArtifactRecorder,
    steps: &mut Vec<StepStats>,
    energy_plateau: &mut RelaxationEnergyPlateauWindow,
    field_schedules: &mut [OutputSchedule],
    mut last_preview_revision: Option<u64>,
) -> Result<LlgOverdampedExecution, RunError> {
    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = plan.time_stage.start_time_s;
    let mut backend_completion: Option<fullmag_ir::StageCompletionIR> = None;
    let mut cancelled = false;
    let mut paused = false;
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();
    let mut last_cached_preview_revision = last_preview_revision;
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
    let mut preview_handoff = FemPreviewHandoff::default();
    let drive_discontinuities = crate::time_events::resolved_stage_drive_discontinuities(
        &plan.field_drives,
        plan.time_stage.start_time_s,
        until_seconds,
        crate::schedules::OUTPUT_TIME_TOLERANCE,
    );

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
                        coupled_checkpoint: None,
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
        if drive_discontinuities
            .iter()
            .any(|event| (*event - current_time).abs() <= crate::schedules::OUTPUT_TIME_TOLERANCE)
        {
            backend.invalidate_fsal()?;
        }
        let proposed_dt = dt.min(until_seconds - current_time);
        let dt_step = crate::time_events::cap_timestep_to_next_event(
            current_time,
            proposed_dt,
            time_event_schedule_s,
            crate::schedules::OUTPUT_TIME_TOLERANCE,
        );
        let interrupt_requested = live
            .as_ref()
            .and_then(|consumer| consumer.interrupt_requested);
        let Some(mut stats) = backend.step_interruptible(dt_step, interrupt_requested)? else {
            if interrupt_requested
                .is_some_and(|signal| signal.load(std::sync::atomic::Ordering::Relaxed))
            {
                cancelled = true;
                break;
            }
            return Err(RunError {
                message: "native FEM LLG step was interrupted without an active interrupt signal"
                    .to_string(),
            });
        };
        stats.preview_schedule_fence_wall_time_ns = preview_schedule_fence_wall_time_ns;
        stats.wall_time_ns = stats
            .wall_time_ns
            .saturating_add(preview_schedule_fence_wall_time_ns);
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
            let mut live_stats = stats.clone();
            let preview_callback_cpu_started = current_thread_cpu_time_ns();
            preview_handoff.reset_timings();
            let preview_start = std::time::Instant::now();
            let magnetization = if stats.step % heavy_payload_every == 0 {
                preview_handoff.request_magnetization(node_count, stats.step)?
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
                        stats.step,
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
                coupled_checkpoint: None,
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
        if cancelled || paused {
            break;
        }

        let due_field_names = field_schedules
            .iter()
            .filter(|schedule| is_due(stats.time, schedule.next_time))
            .map(|schedule| schedule.name.clone())
            .collect::<Vec<_>>();
        for name in due_field_names {
            let metrics = if artifacts.is_streaming() {
                let snapshot =
                    backend.begin_field_snapshot(&name, stats.step, stats.time, stats.dt)?;
                artifacts.record_native_fem_field_snapshot(snapshot)?
            } else {
                let values =
                    super::snapshots::copy_native_fem_field_snapshot(backend, &name, node_count)?;
                artifacts.record_field_snapshot(FieldSnapshot {
                    name,
                    step: stats.step,
                    time: stats.time,
                    solver_dt: stats.dt,
                    component_count: 3,
                    component_order: "xyz".into(),
                    location: "sample".into(),
                    scope: "full".into(),
                    revision: stats.step.saturating_add(1),
                    values: FieldSnapshot::flatten_vec3(values),
                })?
            };
            apply_artifact_enqueue_metrics(&mut stats, metrics);
        }
        advance_due_schedules(field_schedules, stats.time);

        let artifact_metrics = artifacts.record_scalar(&stats)?;
        apply_artifact_enqueue_metrics(&mut stats, artifact_metrics);
        steps.push(stats);

        let latest = steps.last().expect("just pushed stats");
        let energy_plateau_range = energy_plateau.record(latest.e_total);
        let stop_for_relaxation = if let Some(control) = plan.relaxation.as_ref() {
            if let Some(completion) = backend.stage_completion()? {
                backend_completion = Some(completion);
                true
            } else {
                let max_steps_hit = latest.step >= control.stop.max_steps.unwrap_or(u64::MAX);
                let converged = torque_confirmation.observe_stats(
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
        preview_handoff,
    })
}

#[cfg(test)]
mod tests {
    use super::convergence_controller_policy;

    #[test]
    fn convergence_controller_policy_is_explicit_and_versioned() {
        let policy = convergence_controller_policy();
        assert_eq!(policy.policy_id, "relaxation_convergence_v1");
        assert_eq!(policy.torque_confirmation_samples, 3);
        assert_eq!(policy.energy_increase_relative_tolerance, 1.0e-10);
        assert_eq!(policy.energy_increase_absolute_tolerance_j, 1.0e-30);
        assert_eq!(policy.tightening_factor, std::f64::consts::FRAC_1_SQRT_2);
        assert_eq!(policy.max_error_floor, 1.0e-9);
    }

    #[test]
    fn llg_overdamped_does_not_spin_forever_on_interrupted_step() {
        let source = include_str!("llg_overdamped.rs");
        assert!(
            source.contains("native FEM LLG step was interrupted without an active interrupt signal")
                && source.contains("cancelled = true;\n                break;")
                && !source.contains("backend.step_interruptible(dt_step, interrupt_requested)? else {\n            continue;"),
            "FEM LLG must not continue without advancing time when the native step reports interruption"
        );
    }
}
