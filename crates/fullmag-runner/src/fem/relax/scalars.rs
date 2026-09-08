//! Per-object scalar helpers for native FEM relaxation outputs.

use fullmag_ir::FemPlanIR;

use crate::scalar_metrics::{object_scalar_slots, single_object_scalars};
use crate::types::{LiveStepConsumer, StepAction, StepStats, StepUpdate};

pub(crate) fn publish_initial_scalar_without_field_snapshot(
    live: Option<&mut LiveStepConsumer<'_>>,
    stats: &StepStats,
    fem_mesh_generation_id: &Option<String>,
) -> Option<StepAction> {
    let live = live.filter(|consumer| !consumer.initial_snapshot)?;
    Some((live.on_step)(StepUpdate {
        coupled_checkpoint: None,
        stats: stats.clone(),
        grid: live.grid,
        fem_mesh_generation_id: fem_mesh_generation_id.clone(),
        magnetization: None,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        terminal_field_snapshot: false,
        finished: false,
    }))
}

pub(crate) fn ensure_fem_object_scalars(stats: &mut StepStats, plan: &FemPlanIR) {
    if !stats.per_object_scalars.is_empty() {
        return;
    }
    if plan.object_segments.is_empty() {
        stats.per_object_scalars = single_object_scalars("free", stats);
        return;
    }
    // Native FEM publishes global energy reductions.  A node-count fraction
    // is not a physical object-local energy, so keep only explicit object
    // slots here until each interaction has a local integral implementation.
    let slots = object_scalar_slots(
        plan.object_segments
            .iter()
            .filter(|segment| segment.object_id != "__air__")
            .map(|segment| segment.object_id.clone()),
    );
    stats.per_object_scalars = if slots.is_empty() {
        single_object_scalars("free", stats)
    } else {
        slots
    };
}

#[cfg(test)]
mod tests {
    use super::publish_initial_scalar_without_field_snapshot;
    use crate::types::{LiveStepConsumer, StepAction, StepStats};

    #[test]
    fn headless_initial_update_publishes_scalar_without_field_payloads() {
        let mut updates = Vec::new();
        let mut on_step = |update| {
            updates.push(update);
            StepAction::Continue
        };
        let mut live = LiveStepConsumer {
            grid: [0, 0, 0],
            field_every_n: 8,
            initial_snapshot: false,
            display_selection: None,
            interrupt_requested: None,
            on_step: &mut on_step,
        };
        let stats = StepStats {
            step: 0,
            mx: 1.0,
            e_demag: 7.0e-19,
            ..StepStats::default()
        };

        assert_eq!(
            publish_initial_scalar_without_field_snapshot(
                Some(&mut live),
                &stats,
                &Some("mesh-1".to_string()),
            ),
            Some(StepAction::Continue)
        );
        drop(live);
        assert_eq!(updates.len(), 1);
        let update = &updates[0];
        assert_eq!(update.stats.step, 0);
        assert_eq!(update.stats.mx, 1.0);
        assert_eq!(update.stats.e_demag, 7.0e-19);
        assert!(update.scalar_row_due);
        assert!(update.magnetization.is_none());
        assert!(update.preview_field.is_none());
        assert!(update.cached_preview_fields.is_none());
        assert_eq!(update.fem_mesh_generation_id.as_deref(), Some("mesh-1"));
    }

    #[test]
    fn field_initial_snapshot_path_does_not_emit_duplicate_scalar_only_update() {
        let mut call_count = 0;
        let mut on_step = |_| {
            call_count += 1;
            StepAction::Continue
        };
        let mut live = LiveStepConsumer {
            grid: [0, 0, 0],
            field_every_n: 8,
            initial_snapshot: true,
            display_selection: None,
            interrupt_requested: None,
            on_step: &mut on_step,
        };

        assert_eq!(
            publish_initial_scalar_without_field_snapshot(
                Some(&mut live),
                &StepStats::default(),
                &None,
            ),
            None
        );
        drop(live);
        assert_eq!(call_count, 0);
    }
}
