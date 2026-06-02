//! Per-object scalar helpers for native FEM relaxation outputs.

use std::collections::{BTreeSet, HashMap};

use fullmag_ir::{FemMeshPartRole, FemObjectSegmentIR, FemPlanIR};

use crate::scalar_metrics::{single_object_scalars, weighted_object_scalars};
use crate::types::StepStats;

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
