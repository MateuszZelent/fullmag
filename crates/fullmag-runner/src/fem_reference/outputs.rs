use fullmag_engine::fem::{FemLlgProblem, FemLlgState};
use fullmag_ir::{FemMeshPartIR, FemMeshPartRole, FemObjectSegmentIR};

use crate::artifact_pipeline::ArtifactRecorder;
use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
use crate::scalar_metrics::{
    apply_average_m_to_step_stats, average_magnetization_components, set_object_average_m,
    single_object_scalars, weighted_object_scalars,
};
use crate::schedules::{advance_due_schedules, is_due, same_time, OutputSchedule};
use crate::types::{FieldSnapshot, RunError, StateObservables, StepStats};

pub(super) fn record_due_outputs(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
    precomputed_observables: Option<&StateObservables>,
    fallback_scalar_stats: Option<&StepStats>,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(state.time_seconds, schedule.next_time));
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(state.time_seconds, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !scalar_due && due_field_names.is_empty() {
        return Ok(());
    }

    if scalar_due && due_field_names.is_empty() {
        if let Some(stats) = fallback_scalar_stats {
            artifacts.record_scalar(stats)?;
            steps.push(stats.clone());
            advance_due_schedules(scalar_schedules, state.time_seconds);
            return Ok(());
        }
    }

    // Reuse pre-computed observables from live preview paths to avoid a redundant observe call.
    let owned;
    let observables = match precomputed_observables {
        Some(obs) => obs,
        None => {
            owned = observe_state(problem, state, antenna_field)?;
            &owned
        }
    };

    if scalar_due {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            wall_time_ns,
            observables,
            object_segments,
            mesh_parts,
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
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(select_field_values(observables, &name)?),
            })?;
        }
        advance_due_schedules(field_schedules, state.time_seconds);
    }

    Ok(())
}

pub(super) fn record_scalar_snapshot(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let observables = observe_state(problem, state, antenna_field)?;
    let stats = make_step_stats(
        step,
        state.time_seconds,
        solver_dt,
        wall_time_ns,
        &observables,
        object_segments,
        mesh_parts,
    );
    artifacts.record_scalar(&stats)?;
    steps.push(stats);
    Ok(())
}

pub(super) fn record_final_outputs(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
    step: u64,
    solver_dt: f64,
    default_scalar_trace: bool,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
    fallback_scalar_stats: Option<&StepStats>,
) -> Result<(), RunError> {
    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, state.time_seconds))
            .unwrap_or(true);

    let missing_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|time| !same_time(time, state.time_seconds))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !need_scalar && missing_field_names.is_empty() {
        return Ok(());
    }

    if need_scalar && missing_field_names.is_empty() {
        if let Some(stats) = fallback_scalar_stats {
            artifacts.record_scalar(stats)?;
            steps.push(stats.clone());
            return Ok(());
        }
    }

    let observables = observe_state(problem, state, antenna_field)?;
    if need_scalar {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            0,
            &observables,
            object_segments,
            mesh_parts,
        );
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
    }
    for name in missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time: state.time_seconds,
            solver_dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: step.saturating_add(1),
            values: FieldSnapshot::flatten_vec3(select_field_values(&observables, &name)?),
        })?;
    }

    Ok(())
}

pub(super) fn enrich_step_stats_from_magnetization(
    mut stats: StepStats,
    magnetization: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
) -> StepStats {
    apply_average_m_to_step_stats(&mut stats, magnetization);
    stats.per_object_scalars =
        fem_per_object_scalars(object_segments, mesh_parts, magnetization, &stats);
    stats
}

pub(crate) fn observe_state(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
) -> Result<StateObservables, RunError> {
    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("FEM engine observables: {}", e),
    })?;
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
        external_field: observables.external_field,
        antenna_field: antenna_field.to_vec(),
        effective_field: observables.effective_field,
        anisotropy_field: Vec::new(),
        dmi_field: Vec::new(),
        magnetoelastic_field: Vec::new(),
        cubic_anisotropy_field: Vec::new(),
        bulk_dmi_field: Vec::new(),
        oersted_field: Vec::new(),
        thermal_field: Vec::new(),
        exchange_energy: observables.exchange_energy_joules,
        demag_energy: observables.demag_energy_joules,
        external_energy: observables.external_energy_joules,
        anisotropy_energy: 0.0,
        dmi_energy: 0.0,
        total_energy: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        max_torque_Apm: max_torque_apm,
        per_object_scalars: std::collections::HashMap::new(),
    })
}

pub(super) fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
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
        max_torque_Apm: observables.max_torque_Apm,
        max_torque_T: observables.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = fem_per_object_scalars(
        object_segments,
        mesh_parts,
        &observables.magnetization,
        &stats,
    );
    stats
}

pub(super) fn fem_per_object_scalars(
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
    magnetization: &[[f64; 3]],
    stats: &StepStats,
) -> std::collections::HashMap<String, std::collections::HashMap<String, f64>> {
    if object_segments.is_empty() {
        return single_object_scalars("free", stats);
    }

    let mut weights_by_object: std::collections::HashMap<String, f64> =
        std::collections::HashMap::new();
    for segment in object_segments {
        let weight = fem_segment_node_indices(mesh_parts, segment, magnetization.len())
            .len()
            .max(1) as f64;
        *weights_by_object
            .entry(segment.object_id.clone())
            .or_insert(0.0) += weight;
    }
    let weights = weights_by_object.into_iter().collect::<Vec<_>>();
    let mut per_object = weighted_object_scalars(stats, &weights);
    for segment in object_segments {
        let node_indices = fem_segment_node_indices(mesh_parts, segment, magnetization.len());
        if node_indices.is_empty() {
            set_object_average_m(
                &mut per_object,
                &segment.object_id,
                magnetization,
                segment.node_start as usize,
                segment.node_count as usize,
            );
        } else {
            set_object_average_m_by_indices(
                &mut per_object,
                &segment.object_id,
                magnetization,
                &node_indices,
            );
        }
    }
    if per_object.is_empty() {
        return single_object_scalars("free", stats);
    }
    per_object
}

fn runtime_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn fem_mesh_part_matches_segment(part: &FemMeshPartIR, segment: &FemObjectSegmentIR) -> bool {
    part.role == FemMeshPartRole::MagneticObject
        && (part
            .object_id
            .as_deref()
            .is_some_and(|id| runtime_object_ids_match(id, &segment.object_id))
            || part
                .geometry_id
                .as_deref()
                .zip(segment.geometry_id.as_deref())
                .is_some_and(|(part_geometry, segment_geometry)| {
                    runtime_object_ids_match(part_geometry, segment_geometry)
                })
            || runtime_object_ids_match(&part.id, &segment.object_id))
}

fn fem_segment_node_indices(
    mesh_parts: &[FemMeshPartIR],
    segment: &FemObjectSegmentIR,
    total_nodes: usize,
) -> Vec<usize> {
    if let Some(part) = mesh_parts
        .iter()
        .find(|part| fem_mesh_part_matches_segment(part, segment))
    {
        let node_indices = part
            .node_indices
            .iter()
            .map(|index| *index as usize)
            .filter(|index| *index < total_nodes)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !node_indices.is_empty() {
            return node_indices;
        }
    }

    let start = segment.node_start as usize;
    let end = start
        .saturating_add(segment.node_count as usize)
        .min(total_nodes);
    (start..end).collect()
}

fn set_object_average_m_by_indices(
    per_object: &mut std::collections::HashMap<String, std::collections::HashMap<String, f64>>,
    object_id: &str,
    magnetization: &[[f64; 3]],
    node_indices: &[usize],
) {
    let values = node_indices
        .iter()
        .filter_map(|index| magnetization.get(*index).copied())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return;
    }
    let [mx, my, mz] = average_magnetization_components(&values);
    let entry = per_object.entry(object_id.to_string()).or_default();
    entry.insert("mx".to_string(), mx);
    entry.insert("my".to_string(), my);
    entry.insert("mz".to_string(), mz);
}

fn select_field_values(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let comp = &name[dot_pos + 1..];
        let full = select_base_field(observables, base)?;
        let idx = match comp {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            _ => {
                return Err(RunError {
                    message: format!(
                        "snapshot '{}': unsupported component '{}' (use x, y, or z)",
                        name, comp
                    ),
                });
            }
        };
        return Ok(full.iter().map(|v| [v[idx], 0.0, 0.0]).collect());
    }
    select_base_field(observables, name)
}

fn select_base_field(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    match name {
        "m" => Ok(observables.magnetization.clone()),
        "H_ex" => Ok(observables.exchange_field.clone()),
        "H_demag" => Ok(observables.demag_field.clone()),
        "H_ant" => Ok(observables.antenna_field.clone()),
        "H_ext" => Ok(observables.external_field.clone()),
        "H_eff" => Ok(observables.effective_field.clone()),
        "torque" => Ok(observables.torque_field.clone()),
        other => Err(RunError {
            message: format!(
                "CPU FEM snapshot: field '{}' is not available in this execution path \
                 (available: m, H_ex, H_demag, H_ant, H_ext, H_eff)",
                other
            ),
        }),
    }
}
