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

/// Exact volume-cell membership for an equilibrium projection. Boundary and
/// node selectors cannot manufacture a volume ROI at shared interfaces.
pub fn resolve_fem_antenna_transverse_cell_mask(
    plan: &FemPlanIR, target: &FieldTargetIR,
) -> Result<Vec<bool>, PlanError> {
    let mut mask = vec![matches!(target, FieldTargetIR::Global {}); plan.mesh.cells.len()];
    let mark = |mask: &mut [bool], selector: &FemMeshPartSelector| -> Result<(), PlanError> {
        match selector {
            FemMeshPartSelector::ElementRange { start, count } => {
                mark_range(mask, *start, *count, "equilibrium volume ROI")
            },
            FemMeshPartSelector::ElementMarkerSet { markers } => {
                if plan.mesh.element_markers.len() != mask.len() {
                    return Err(PlanError { reasons: vec!["equilibrium volume ROI requires complete element markers".into()] });
                }
                for (selected, marker) in mask.iter_mut().zip(&plan.mesh.element_markers) {
                    *selected |= markers.contains(marker);
                }
                Ok(())
            },
            _ => Err(PlanError { reasons: vec!["equilibrium ROI requires a volume-element selector".into()] }),
        }
    };
    if let FieldTargetIR::Object { object_id } = target {
        for segment in plan.object_segments.iter().filter(|s| &s.object_id == object_id) {
            mark_range(&mut mask, segment.element_start, segment.element_count, "equilibrium object ROI")?;
        }
    }
    for part in &plan.mesh_parts {
        let selected = match target {
            FieldTargetIR::Object { object_id } => part.object_id.as_ref() == Some(object_id),
            FieldTargetIR::Region { object_id, region_id } => part.object_id.as_ref() == Some(object_id) && &part.id == region_id,
            FieldTargetIR::Global {} => false,
        };
        if selected { mark(&mut mask, &part.element_selector)?; }
    }
    let mut magnetic = vec![false; mask.len()];
    if !plan.region_materials.is_empty() {
        let markers: std::collections::BTreeSet<_> = plan.region_materials.iter()
            .filter(|region| region.material.saturation_magnetisation > 0.0)
            .map(|region| region.element_marker).collect();
        if plan.mesh.element_markers.len() != mask.len() {
            return Err(PlanError { reasons: vec!["equilibrium magnetic regions require complete element markers".into()] });
        }
        for (selected, marker) in magnetic.iter_mut().zip(&plan.mesh.element_markers) {
            *selected = markers.contains(marker);
        }
    } else if !plan.mesh_parts.is_empty() {
        for part in &plan.mesh_parts {
            if part.role == fullmag_ir::FemMeshPartRole::MagneticObject { mark(&mut magnetic, &part.element_selector)?; }
        }
    } else if plan.material.saturation_magnetisation > 0.0
        && plan.material.ms_field.as_ref().is_none_or(|values| values.iter().all(|value| *value > 0.0))
        && plan.mesh.element_markers.iter().all(|marker| Some(marker) == plan.mesh.element_markers.first())
    {
        // A homogeneous resolved magnetic plan has no auxiliary subdomains.
        magnetic.fill(true);
    }
    if let Some(values) = &plan.ms_element_field {
        if values.len() != magnetic.len() { return Err(PlanError { reasons: vec!["equilibrium element MS shape mismatch".into()] }); }
        for (selected, value) in magnetic.iter_mut().zip(values) { *selected &= value.is_finite() && *value > 0.0; }
    }
    for (selected, magnetic) in mask.iter_mut().zip(magnetic) { *selected &= magnetic; }
    if !mask.iter().any(|selected| *selected) {
        return Err(PlanError { reasons: vec!["equilibrium target has no unambiguous magnetic volume cells".into()] });
    }
    Ok(mask)
}
