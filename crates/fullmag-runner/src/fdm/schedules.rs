//! Shared FDM schedule helpers.

use crate::artifact_pipeline::ArtifactRecorder;
use crate::fdm::artifacts::select_state_observable_field;
use crate::schedules::{advance_due_schedules, is_due, OutputSchedule};
use crate::types::{FieldSnapshot, RunError, StateObservables};

pub(crate) fn record_due_fields(
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time,
            solver_dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: step.saturating_add(1),
            values: FieldSnapshot::flatten_vec3(select_state_observable_field(observables, &name, false)?),
        })?;
    }

    advance_due_schedules(field_schedules, time);
    Ok(())
}
