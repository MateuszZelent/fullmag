use fullmag_ir::{FemMeshPartIR, FemMeshPartSelector, FemPlanIR, FieldTargetIR};

use crate::PlanError;

fn mark_range(mask: &mut [bool], start: u32, count: u32, label: &str) -> Result<(), PlanError> {
    let start = start as usize;
    let end = start.checked_add(count as usize).ok_or_else(|| PlanError {
        reasons: vec![format!("{label} node range overflows")],
    })?;
    let node_count = mask.len();
    let selected = mask.get_mut(start..end).ok_or_else(|| PlanError {
        reasons: vec![format!(
            "{label} node range [{start}, {end}) exceeds mesh node count {}",
            node_count
        )],
    })?;
    selected.fill(true);
    Ok(())
}

fn mark_part_nodes(
    plan: &FemPlanIR,
    part: &FemMeshPartIR,
    mask: &mut [bool],
) -> Result<(), PlanError> {
    for &node in &part.node_indices {
        let node_count = mask.len();
        let selected = mask.get_mut(node as usize).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "FEM mesh part '{}' node {node} exceeds mesh node count {node_count}",
                part.id
            )],
        })?;
        *selected = true;
    }
    match &part.node_selector {
        FemMeshPartSelector::NodeRange { start, count } => mark_range(
            mask,
            *start,
            *count,
            &format!("FEM mesh part '{}'", part.id),
        )?,
        FemMeshPartSelector::ElementRange { start, count } => {
            let start = *start as usize;
            let end = start
                .checked_add(*count as usize)
                .ok_or_else(|| PlanError {
                    reasons: vec![format!(
                        "FEM mesh part '{}' element range overflows",
                        part.id
                    )],
                })?;
            if end > plan.mesh.cells.len() {
                return Err(PlanError {
                    reasons: vec![format!(
                        "FEM mesh part '{}' element range exceeds mesh element count {}",
                        part.id,
                        plan.mesh.cells.len()
                    )],
                });
            }
            for element in start..end {
                for &node in plan.mesh.cells.item_nodes(element).unwrap_or_default() {
                    let node_count = mask.len();
                    let selected = mask.get_mut(node as usize).ok_or_else(|| PlanError {
                        reasons: vec![format!(
                            "FEM mesh part '{}' element references node {node} beyond {node_count}",
                            part.id
                        )],
                    })?;
                    *selected = true;
                }
            }
        }
        FemMeshPartSelector::ElementMarkerSet { markers } => {
            for (element, marker) in plan.mesh.element_markers.iter().copied().enumerate() {
                if markers.contains(&marker) {
                    for &node in plan.mesh.cells.item_nodes(element).unwrap_or_default() {
                        let node_count = mask.len();
                        let selected = mask.get_mut(node as usize).ok_or_else(|| PlanError {
                            reasons: vec![format!(
                                "FEM mesh part '{}' marker references node {node} beyond {node_count}",
                                part.id
                            )],
                        })?;
                        *selected = true;
                    }
                }
            }
        }
        FemMeshPartSelector::BoundaryFaceRange { .. } => {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM mesh part '{}' cannot project a volume field from a boundary-only node selector",
                    part.id
                )],
            });
        }
    }
    Ok(())
}

/// Resolve the authored antenna target to the exact nodal mask consumed by
/// `antenna_field_solution.v1`. Global retains airbox samples; object and
/// region targets use the canonical shared-domain segment/mesh-part mapping.
pub fn resolve_fem_antenna_projection_mask(
    plan: &FemPlanIR,
    target: &FieldTargetIR,
) -> Result<Option<Vec<bool>>, PlanError> {
    if matches!(target, FieldTargetIR::Global {}) {
        return Ok(None);
    }
    let mut mask = vec![false; plan.mesh.nodes.len()];
    match target {
        FieldTargetIR::Object { object_id } => {
            for segment in plan
                .object_segments
                .iter()
                .filter(|segment| segment.object_id == *object_id)
            {
                mark_range(
                    &mut mask,
                    segment.node_start,
                    segment.node_count,
                    &format!("FEM object segment '{object_id}'"),
                )?;
            }
            for part in plan
                .mesh_parts
                .iter()
                .filter(|part| part.object_id.as_deref() == Some(object_id))
            {
                mark_part_nodes(plan, part, &mut mask)?;
            }
        }
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => {
            for part in plan.mesh_parts.iter().filter(|part| {
                part.object_id.as_deref() == Some(object_id) && part.id == *region_id
            }) {
                mark_part_nodes(plan, part, &mut mask)?;
            }
        }
        FieldTargetIR::Global {} => unreachable!(),
    }
    if !mask.iter().any(|selected| *selected) {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna target {target:?} has no resolved nodes in the shared FEM mesh"
            )],
        });
    }
    Ok(Some(mask))
}
