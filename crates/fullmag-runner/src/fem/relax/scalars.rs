//! Per-object scalar helpers for native FEM relaxation outputs.

use std::collections::{BTreeSet, HashMap};

use fullmag_ir::{FemMeshPartRole, FemObjectSegmentIR, FemPlanIR};

use crate::scalar_metrics::{single_object_scalars, weighted_object_scalars};
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
    let mut weights: HashMap<String, f64> = HashMap::new();
    for segment in &plan.object_segments {
        let weight = fem_segment_weight(plan, segment);
        *weights.entry(segment.object_id.clone()).or_insert(0.0) += weight;
    }
    let weighted = weighted_object_scalars(stats, &weights.into_iter().collect::<Vec<_>>());
    stats.per_object_scalars = if weighted.is_empty() {
        single_object_scalars("free", stats)
    } else {
        weighted
    };
}

fn fem_segment_weight(plan: &FemPlanIR, segment: &FemObjectSegmentIR) -> f64 {
    let explicit_count = plan
        .mesh_parts
        .iter()
        .find(|part| {
            part.role == FemMeshPartRole::MagneticObject
                && (part
                    .object_id
                    .as_deref()
                    .is_some_and(|id| fem_object_ids_match(id, &segment.object_id))
                    || part
                        .geometry_id
                        .as_deref()
                        .zip(segment.geometry_id.as_deref())
                        .is_some_and(|(part_geometry, segment_geometry)| {
                            fem_object_ids_match(part_geometry, segment_geometry)
                        })
                    || fem_object_ids_match(&part.id, &segment.object_id))
        })
        .map(|part| {
            part.node_indices
                .iter()
                .filter(|index| (**index as usize) < plan.mesh.nodes.len())
                .collect::<BTreeSet<_>>()
                .len()
        })
        .unwrap_or(0);
    if explicit_count > 0 {
        explicit_count as f64
    } else {
        f64::from(segment.node_count.max(1))
    }
}

fn fem_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
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
