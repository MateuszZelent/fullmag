use fullmag_engine::{ExchangeLlgProblem, ExchangeLlgState, StepReport, Vector3};

use crate::artifact_pipeline::ArtifactRecorder;
use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
use crate::fdm::artifacts::select_state_observable_field;
use crate::scalar_metrics::{apply_average_m_to_step_stats, single_object_scalars};
use crate::schedules::{advance_due_schedules, is_due, same_time, OutputSchedule};
use crate::types::{FieldSnapshot, RunError, StateObservables, StepStats};

use super::direct_snapshot::{direct_field_values_available, DirectFieldSnapshotCache};

pub(super) fn record_due_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    step_report: Option<&StepReport>,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(state.time_seconds, schedule.next_time));
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(state.time_seconds, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    let has_due_fields = !due_field_names.is_empty();

    if !scalar_due && due_field_names.is_empty() {
        return Ok(());
    }

    if due_field_names
        .iter()
        .all(|name| direct_field_values_available(name))
        && (!scalar_due || step_report.is_some())
    {
        if let Some(report) = step_report.filter(|_| scalar_due) {
            let stats =
                make_step_stats_from_report(step, report, wall_time_ns, state.magnetization());
            artifacts.record_scalar(&stats)?;
            steps.push(stats);
            advance_due_schedules(scalar_schedules, state.time_seconds);
        }

        let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
        for name in due_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: direct_fields.select(&name)?,
            })?;
        }
        if has_due_fields {
            advance_due_schedules(field_schedules, state.time_seconds);
        }
        return Ok(());
    }

    let observables = observe_state(problem, state)?;

    if scalar_due {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            wall_time_ns,
            &observables,
        );
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
        advance_due_schedules(scalar_schedules, state.time_seconds);
    }

    if !due_field_names.is_empty() {
        for name in due_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: select_state_observable_field(&observables, &name, true)?,
            })?;
        }
        advance_due_schedules(field_schedules, state.time_seconds);
    }

    Ok(())
}

pub(super) fn record_scalar_snapshot(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let observables = observe_state(problem, state)?;
    let stats = make_step_stats(
        step,
        state.time_seconds,
        solver_dt,
        wall_time_ns,
        &observables,
    );
    artifacts.record_scalar(&stats)?;
    steps.push(stats);
    Ok(())
}

pub(super) fn record_final_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    step: u64,
    solver_dt: f64,
    default_scalar_trace: bool,
    final_step_report: Option<&StepReport>,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let has_current_scalar = steps
        .last()
        .map(|stats| same_time(stats.time, state.time_seconds))
        .unwrap_or(false);
    let need_scalar = !has_current_scalar
        && (default_scalar_trace
            || steps
                .last()
                .map(|stats| !same_time(stats.time, state.time_seconds))
                .unwrap_or(true));

    let requested_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|time| !same_time(time, state.time_seconds))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    let missing_field_names = requested_field_names
        .into_iter()
        .filter(|name| {
            !field_schedules.iter().any(|schedule| {
                schedule.name == *name
                    && schedule
                        .last_sampled_time
                        .map(|time| same_time(time, state.time_seconds))
                        .unwrap_or(false)
            })
        })
        .collect::<Vec<_>>();

    if !need_scalar && missing_field_names.is_empty() {
        return Ok(());
    }

    if !need_scalar
        && missing_field_names
            .iter()
            .all(|name| direct_field_values_available(name))
    {
        let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
        for name in missing_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: direct_fields.select(&name)?,
            })?;
        }
        return Ok(());
    }

    if need_scalar
        && final_step_report
            .is_some_and(|report| same_time(report.time_seconds, state.time_seconds))
        && missing_field_names
            .iter()
            .all(|name| direct_field_values_available(name))
    {
        let report = final_step_report.expect("checked final step report");
        let stats = make_step_stats_from_report(step, report, 0, state.magnetization());
        artifacts.record_scalar(&stats)?;
        steps.push(stats);

        let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
        for name in missing_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: direct_fields.select(&name)?,
            })?;
        }
        return Ok(());
    }

    let observables = observe_state(problem, state)?;

    if need_scalar {
        let stats = make_step_stats(step, state.time_seconds, solver_dt, 0, &observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
    }

    for name in missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time: state.time_seconds,
            solver_dt,
            values: select_state_observable_field(&observables, &name, true)?,
        })?;
    }

    Ok(())
}

pub(crate) fn observe_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
) -> Result<StateObservables, RunError> {
    #[cfg(test)]
    super::increment_observe_state_calls();

    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("Engine observables: {}", e),
    })?;
    let uniform_external = if let Some(field) = problem.terms.external_field {
        state
            .magnetization()
            .iter()
            .enumerate()
            .map(|(index, _)| {
                if problem
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask[index])
                {
                    [0.0, 0.0, 0.0]
                } else {
                    field
                }
            })
            .collect()
    } else {
        vec![[0.0, 0.0, 0.0]; state.magnetization().len()]
    };
    let oersted_field = problem.oersted_field_at_time(state.time_seconds);
    let anisotropy_field = problem.anisotropy_field(state.magnetization());

    let torque_field = compute_torque_field(
        &observables.magnetization,
        &observables.effective_field,
        problem.material.damping,
        problem.dynamics.precession_enabled,
    );
    let max_torque_apm = max_torque_residual_apm_from_field(
        &observables.magnetization,
        &observables.effective_field,
    );

    Ok(StateObservables {
        magnetization: observables.magnetization,
        torque_field,
        exchange_field: observables.exchange_field,
        demag_field: observables.demag_field,
        external_field: uniform_external,
        antenna_field: vec![[0.0, 0.0, 0.0]; state.magnetization().len()],
        effective_field: observables.effective_field,
        anisotropy_field,
        dmi_field: observables.dmi_field,
        magnetoelastic_field: Vec::new(),
        cubic_anisotropy_field: Vec::new(),
        bulk_dmi_field: Vec::new(),
        oersted_field,
        thermal_field: Vec::new(),
        exchange_energy: observables.exchange_energy_joules,
        demag_energy: observables.demag_energy_joules,
        external_energy: observables.external_energy_joules,
        anisotropy_energy: observables.anisotropy_energy_joules,
        dmi_energy: observables.dmi_energy_joules,
        total_energy: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        max_torque_Apm: max_torque_apm,
        per_object_scalars: std::collections::HashMap::new(),
    })
}

pub(super) fn make_step_stats_from_report(
    step: u64,
    report: &StepReport,
    wall_time_ns: u64,
    magnetization: &[Vector3],
) -> StepStats {
    let mut stats = StepStats {
        step,
        time: report.time_seconds,
        dt: report.dt_used,
        e_ex: report.exchange_energy_joules,
        e_demag: report.demag_energy_joules,
        e_ext: report.external_energy_joules,
        e_ani: report.anisotropy_energy_joules,
        e_dmi: report.dmi_energy_joules,
        e_total: report.total_energy_joules,
        max_dm_dt: report.max_rhs_amplitude,
        max_h_eff: report.max_effective_field_amplitude,
        max_h_demag: report.max_demag_field_amplitude,
        max_torque_Apm: report.max_torque_Apm,
        max_torque_T: report.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, magnetization);
    stats.per_object_scalars = single_object_scalars("free", &stats);
    stats
}

pub(super) fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: solver_dt,
        e_ex: observables.exchange_energy,
        e_demag: observables.demag_energy,
        e_ext: observables.external_energy,
        e_ani: observables.anisotropy_energy,
        e_dmi: observables.dmi_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = if observables.per_object_scalars.is_empty() {
        single_object_scalars("free", &stats)
    } else {
        observables.per_object_scalars.clone()
    };
    stats
}
