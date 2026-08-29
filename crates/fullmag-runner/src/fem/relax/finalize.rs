//! Native FEM relaxation finalization.
//!
//! The execution loops own stepping. This module owns the post-loop relaxation
//! closure: final stats, cached-preview flush, scheduled field snapshots,
//! provenance refresh, and stage-completion projection.

use fullmag_ir::FemPlanIR;

use crate::artifact_pipeline::ArtifactRecorder;
use crate::dispatch::{apply_native_fem_runtime_contract, fem_poisson_demag_provenance, FemEngine};
use crate::fem::execution_receipt::validate_strict_fem_gpu_execution_receipt;
use crate::native_fem::NativeFemBackend;
use crate::relaxation::{resolve_stage_completion, RelaxationCompletionMetrics};
use crate::schedules::{same_time, OutputSchedule};
use crate::types::{
    AuxiliaryArtifact, CertifiedFemEquilibriumFields, ExecutedRun, FieldSnapshot, LiveStepConsumer,
    RunError, RunResult, RunStatus, StepStats, StepUpdate,
};

use super::preview::FemPreviewHandoff;
use super::scalars::ensure_fem_object_scalars;
use super::snapshots::copy_native_fem_field_snapshot;

#[cfg(test)]
mod tests {
    use super::{run_after_strict_receipt_gate, terminal_scheduled_field_actions};
    use crate::schedules::OutputSchedule;
    use crate::types::{FemGpuExecutionClass, FemGpuExecutionReceipt};

    fn schedule(name: &str, last_sampled_time: Option<f64>) -> OutputSchedule {
        OutputSchedule {
            name: name.to_string(),
            every_seconds: 1.0e-14,
            next_time: 2.0e-14,
            last_sampled_time,
        }
    }

    #[test]
    fn terminal_actions_deduplicate_payload_but_retain_streaming_demag_diagnostics() {
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("m", Some(2.0e-14)), 2.0e-14, true),
            (false, false)
        );
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("H_demag", Some(2.0e-14)), 2.0e-14, true,),
            (false, true)
        );
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("demag_phi", None), 2.0e-14, true),
            (true, true)
        );
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("m", None), 2.0e-14, false),
            (true, false)
        );
    }

    #[test]
    fn invalid_strict_receipt_executes_zero_terminal_success_side_effects() {
        let receipt = FemGpuExecutionReceipt {
            requested: "strict_device".into(),
            resolved: "device_resident".into(),
            executed: "cuda_fem".into(),
            execution_class: FemGpuExecutionClass::DeviceResident,
            device_ordinal: 0,
            precision: "double".into(),
            integrator: "heun".into(),
            required_operator_mask: 0x3ff,
            resolved_device_operator_mask: 0x3ff,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0x3ff,
            executed_host_operator_mask: 1,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 1,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            accounting_valid: true,
        };
        let mut terminal_side_effects = 0;
        let result = run_after_strict_receipt_gate(&receipt, "strict_device", || {
            terminal_side_effects += 1;
        });
        assert!(result.is_err());
        assert_eq!(terminal_side_effects, 0);
    }
}

fn run_after_strict_receipt_gate<T>(
    receipt: &crate::types::FemGpuExecutionReceipt,
    request: &str,
    success: impl FnOnce() -> T,
) -> Result<T, RunError> {
    if request == "strict_device" {
        validate_strict_fem_gpu_execution_receipt(receipt).map_err(|error| RunError {
            message: format!(
                "strict native FEM GPU execution receipt rejected: {}",
                error.token()
            ),
        })?;
    }
    Ok(success())
}

pub(crate) struct NativeFemRelaxationFinalization {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) terminal_stats: Option<StepStats>,
    pub(crate) backend_completion: Option<fullmag_ir::StageCompletionIR>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
    pub(crate) preview_handoff: FemPreviewHandoff,
    pub(crate) fem_gpu_receipt_request: String,
}

fn terminal_scheduled_field_actions(
    schedule: &OutputSchedule,
    final_time: f64,
    streaming: bool,
) -> (bool, bool) {
    let payload_already_sampled = schedule
        .last_sampled_time
        .is_some_and(|time| same_time(time, final_time));
    let diagnostic_copy = streaming && matches!(schedule.name.as_str(), "H_demag" | "demag_phi");
    (!payload_already_sampled, diagnostic_copy)
}

pub(crate) fn finalize_native_fem_relaxation(
    backend: &mut NativeFemBackend,
    engine: FemEngine,
    plan: &FemPlanIR,
    fem_mesh_generation_id: &Option<String>,
    node_count: usize,
    initial_magnetization: Vec<[f64; 3]>,
    mut field_schedules: Vec<OutputSchedule>,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: ArtifactRecorder,
    mut steps: Vec<StepStats>,
    finalization: NativeFemRelaxationFinalization,
) -> Result<ExecutedRun, RunError> {
    let mut artifacts = artifacts;
    let mut final_stats = finalization.latest_stats.unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_ani: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });
    // Construct the one final provenance value before any terminal success
    // side effect. The same value is published to open stores and returned in
    // ExecutedRun; no later provenance mutation is permitted.
    let mut final_provenance = artifacts.provenance_snapshot();
    final_provenance.fem_poisson_demag = fem_poisson_demag_provenance(plan, Some(&final_stats));
    let gpu_state_info = backend.gpu_state_info()?;
    let gpu_rk_plan_info = backend.gpu_rk_plan_info()?;
    apply_native_fem_runtime_contract(
        &mut final_provenance,
        plan,
        Some(&final_stats),
        Some(&gpu_state_info),
        Some(&gpu_rk_plan_info),
    );
    if engine == FemEngine::NativeGpu {
        let receipt = backend
            .gpu_execution_receipt()?
            .into_provenance(&finalization.fem_gpu_receipt_request);
        run_after_strict_receipt_gate(&receipt, &finalization.fem_gpu_receipt_request, || {
            final_provenance.fem_gpu_execution_receipt = Some(receipt.clone())
        })?;
    }
    artifacts.replace_provenance_synchronously(final_provenance)?;
    if let Some(mut terminal_stats) = finalization.terminal_stats {
        // Retain a terminal torque-confirmation observation for final-state
        // provenance. The artifact writer marks same-step observations as
        // non-accepted, so this cannot inflate accepted-step telemetry.
        ensure_fem_object_scalars(&mut terminal_stats, plan);
        artifacts.record_scalar(&terminal_stats)?;
        steps.push(terminal_stats);
    }
    ensure_fem_object_scalars(&mut final_stats, plan);
    let finalization_start = std::time::Instant::now();
    let mut finalization_field_copy_wall_time_ns = 0_u64;
    let mut finalization_field_copy_bytes = 0_u64;
    let mut diagnostic_field_snapshots = Vec::<FieldSnapshot>::new();

    let terminal_preview_started = std::time::Instant::now();
    let terminal_preview_deadline = terminal_preview_started + std::time::Duration::from_secs(5);
    let mut preview_handoff = finalization.preview_handoff;
    let initial_drain_started = std::time::Instant::now();
    let pending_preview_completed =
        preview_handoff.finalize_pending_until(terminal_preview_deadline);
    eprintln!(
        "[fullmag-runner] native-fem terminal preview phase: phase=initial_pending_drain completed={} wall_time_ns={} deadline_remaining_ms={}",
        pending_preview_completed,
        elapsed_ns(initial_drain_started),
        terminal_preview_deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis(),
    );

    // Refresh device-resident component fields at the accepted final state
    // before any synchronous or asynchronous field snapshot selects H_eff.
    // This is required for strict GPU runs without device Poisson demag too.
    let _refreshed_final_snapshot_stats = backend.snapshot_step_stats(node_count)?;

    if let Some(live) = live.as_mut() {
        if let Some(display_selection) = live.display_selection.map(|get| get()) {
            let publication = if pending_preview_completed {
                preview_handoff.finalize_terminal_cache(
                    backend,
                    engine,
                    &display_selection,
                    plan,
                    node_count,
                    final_stats.step,
                    final_stats.time,
                    final_stats.dt,
                    terminal_preview_deadline,
                )
            } else {
                preview_handoff.take_terminal_publication(elapsed_ns(terminal_preview_started))
            };
            let mut live_stats = final_stats.clone();
            live_stats.cached_preview_wall_time_ns = publication.wall_time_ns;
            live_stats.field_materialization_states = publication.materialization_states;
            live_stats.wall_time_ns = live_stats
                .wall_time_ns
                .saturating_add(publication.wall_time_ns);
            let magnetization = publication.magnetization.map(|payload| {
                live_stats.magnetization_source_step = Some(payload.source_step);
                live_stats.magnetization_source_revision = Some(payload.source_revision);
                live_stats.magnetization_materialized_at_unix_ms =
                    Some(payload.materialized_at_unix_ms);
                live_stats.magnetization_materialization_wall_time_ns =
                    Some(payload.materialization_wall_time_ns);
                live_stats.field_copy_wall_time_ns = live_stats
                    .field_copy_wall_time_ns
                    .saturating_add(payload.materialization_wall_time_ns);
                live_stats.field_copy_bytes = live_stats
                    .field_copy_bytes
                    .saturating_add(payload.field_copy_bytes);
                payload.values
            });
            eprintln!(
                "[fullmag-runner] native-fem terminal preview phase: phase=publication cached_fields={} magnetization={} states={} wall_time_ns={} deadline_remaining_ms={}",
                publication
                    .cached_fields
                    .as_ref()
                    .map_or(0, |fields| fields.len()),
                magnetization.is_some(),
                live_stats.field_materialization_states.len(),
                publication.wall_time_ns,
                terminal_preview_deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis(),
            );
            if let Some(last_step) = steps.last_mut() {
                *last_step = live_stats.clone();
            }
            let _ = (live.on_step)(StepUpdate {
                coupled_checkpoint: None,
                stats: live_stats,
                grid: live.grid,
                fem_mesh_generation_id: fem_mesh_generation_id.clone(),
                magnetization,
                preview_field: None,
                cached_preview_fields: publication.cached_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: false,
                terminal_field_snapshot: true,
                finished: false,
            });
        }
    }
    drop(preview_handoff);

    if !pending_preview_completed {
        let _refreshed_final_snapshot_stats = backend.snapshot_step_stats(node_count)?;
    }

    let scheduled_names = field_schedules
        .iter()
        .map(|schedule| schedule.name.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    for name in artifacts
        .due_accepted_step_fields(final_stats.step, true)
        .into_iter()
        .filter(|name| !scheduled_names.contains(name.as_str()))
    {
        let copy_start = std::time::Instant::now();
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(
                &name,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
            )?;
            artifacts.record_native_fem_field_snapshot(snapshot)?;
        } else {
            let values = copy_native_fem_field_snapshot(backend, &name, node_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name,
                step: final_stats.step,
                time: final_stats.time,
                solver_dt: final_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: final_stats.step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
        finalization_field_copy_wall_time_ns =
            finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
    }

    for schedule in &mut field_schedules {
        let (enqueue_payload, copy_diagnostic) =
            terminal_scheduled_field_actions(schedule, final_stats.time, artifacts.is_streaming());
        if !enqueue_payload && !copy_diagnostic {
            continue;
        }
        let copy_start = std::time::Instant::now();
        if artifacts.is_streaming() {
            if enqueue_payload {
                let snapshot = backend.begin_field_snapshot(
                    &schedule.name,
                    final_stats.step,
                    final_stats.time,
                    final_stats.dt,
                )?;
                artifacts.record_native_fem_field_snapshot(snapshot)?;
            }
            if copy_diagnostic {
                let values = copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?;
                diagnostic_field_snapshots.push(FieldSnapshot {
                    name: schedule.name.clone(),
                    step: final_stats.step,
                    time: final_stats.time,
                    solver_dt: final_stats.dt,
                    component_count: 3,
                    component_order: "xyz".into(),
                    location: "sample".into(),
                    scope: "full".into(),
                    revision: (final_stats.step as u64).saturating_add(1),
                    values: FieldSnapshot::flatten_vec3(values),
                });
            }
            finalization_field_copy_wall_time_ns =
                finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
            finalization_field_copy_bytes =
                finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(node_count));
        } else {
            let values = copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?;
            finalization_field_copy_wall_time_ns =
                finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
            finalization_field_copy_bytes =
                finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(values.len()));
            artifacts.record_field_snapshot(FieldSnapshot {
                name: schedule.name.clone(),
                step: final_stats.step,
                time: final_stats.time,
                solver_dt: final_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (final_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }

    let copy_start = std::time::Instant::now();
    let final_magnetization = copy_native_fem_field_snapshot(backend, "m", node_count)?;
    let h_ex_a_per_m = backend.copy_linearization_field(
        fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
        node_count,
    )?;
    let h_demag_a_per_m = backend.copy_linearization_field(
        fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG,
        node_count,
    )?;
    let h_ext_a_per_m = backend.copy_linearization_field(
        fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT,
        node_count,
    )?;
    let h_eff_a_per_m = backend.copy_linearization_field(
        fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EFF,
        node_count,
    )?;
    let phi_a = backend.copy_demag_phi(node_count)?;
    let certified_fem_equilibrium_fields = CertifiedFemEquilibriumFields::from_fields(
        h_ex_a_per_m,
        h_demag_a_per_m,
        h_ext_a_per_m,
        h_eff_a_per_m,
        phi_a,
    )?;
    finalization_field_copy_wall_time_ns =
        finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
    finalization_field_copy_bytes =
        finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(final_magnetization.len()));
    let (mut field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let mut auxiliary_artifacts = Vec::new();
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "equilibrium/certified_fem_equilibrium_fields.v1.json".into(),
        bytes: serde_json::to_vec_pretty(&certified_fem_equilibrium_fields).map_err(|error| {
            RunError {
                message: format!("failed to encode certified FEM equilibrium fields: {error}"),
            }
        })?,
    });
    if let Some(telemetry) = backend.stage_oersted_telemetry() {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "transport/fem_stage_oersted_callback.v1.json".into(),
            bytes: serde_json::to_vec_pretty(&telemetry).map_err(|error| RunError {
                message: format!("failed to encode FEM stage Oersted telemetry: {error}"),
            })?,
        });
    }
    if let Some(telemetry) = backend.stage_transport_telemetry() {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "transport/fem_stage_transport_callback.v1.json".into(),
            bytes: serde_json::to_vec_pretty(&telemetry).map_err(|error| RunError {
                message: format!("failed to encode FEM stage transport telemetry: {error}"),
            })?,
        });
    }
    field_snapshots.extend(diagnostic_field_snapshots);
    let finalization_wall_time_ns = elapsed_ns(finalization_start);
    final_stats.finalization_wall_time_ns = finalization_wall_time_ns;
    final_stats.finalization_field_copy_wall_time_ns = finalization_field_copy_wall_time_ns;
    final_stats.finalization_field_copy_bytes = finalization_field_copy_bytes;
    final_stats.wall_time_ns = final_stats
        .wall_time_ns
        .saturating_add(finalization_wall_time_ns);
    if let Some(last_step) = steps.last_mut() {
        last_step.finalization_wall_time_ns = finalization_wall_time_ns;
        last_step.finalization_field_copy_wall_time_ns = finalization_field_copy_wall_time_ns;
        last_step.finalization_field_copy_bytes = finalization_field_copy_bytes;
        last_step.wall_time_ns = last_step
            .wall_time_ns
            .saturating_add(finalization_wall_time_ns);
    }
    let status = if finalization.paused {
        RunStatus::Paused
    } else if finalization.cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = if let Some(mut completion) = finalization.backend_completion {
        completion.status = match status {
            RunStatus::Completed => "completed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Paused => "paused",
            RunStatus::Failed => "failed",
        }
        .to_string();
        completion
    } else {
        resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            RelaxationCompletionMetrics {
                max_torque_apm: None,
                torque_confirmed: false,
                accepted_energy_plateau_range_j: None,
                steps: final_stats.step,
                relaxation_time_s: Some(final_stats.time),
                numerical_stagnation: false,
            },
        )
    };

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
        auxiliary_artifacts,
        provenance,
    })
}

fn elapsed_ns(start: std::time::Instant) -> u64 {
    start.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
}

fn vector3_f64_bytes(len: usize) -> u64 {
    let bytes = len
        .saturating_mul(3)
        .saturating_mul(std::mem::size_of::<f64>());
    bytes.min(u64::MAX as usize) as u64
}
