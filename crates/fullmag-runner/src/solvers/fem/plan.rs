//! FEM plan normalization before runtime handoff.

use std::collections::BTreeSet;

use fullmag_ir::{FemMeshPartSelector, FemPlanIR};

use crate::types::RunError;

fn magnetic_markers_from_object_segments(plan: &FemPlanIR) -> BTreeSet<u32> {
    if plan.mesh.element_markers.is_empty() {
        return BTreeSet::new();
    }
    let mut markers = BTreeSet::new();
    for segment in &plan.object_segments {
        if segment.element_count == 0 {
            continue;
        }
        let start = segment.element_start as usize;
        let end = start
            .saturating_add(segment.element_count as usize)
            .min(plan.mesh.element_markers.len());
        if start >= end {
            continue;
        }
        for marker in &plan.mesh.element_markers[start..end] {
            if *marker != 0 {
                markers.insert(*marker);
            }
        }
    }
    markers
}

fn markers_from_element_selector(
    selector: &FemMeshPartSelector,
    mesh_element_markers: &[u32],
) -> BTreeSet<u32> {
    match selector {
        FemMeshPartSelector::ElementMarkerSet { markers } => markers
            .iter()
            .copied()
            .filter(|marker| *marker != 0)
            .collect(),
        FemMeshPartSelector::ElementRange { start, count } => {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(mesh_element_markers.len());
            if start >= end {
                return BTreeSet::new();
            }
            mesh_element_markers[start..end]
                .iter()
                .copied()
                .filter(|marker| *marker != 0)
                .collect()
        }
        _ => BTreeSet::new(),
    }
}

fn magnetic_markers_from_mesh_parts(plan: &FemPlanIR) -> BTreeSet<u32> {
    if plan.mesh.element_markers.is_empty() {
        return BTreeSet::new();
    }
    let mut markers = BTreeSet::new();
    for part in &plan.mesh_parts {
        if part.role != fullmag_ir::FemMeshPartRole::MagneticObject {
            continue;
        }
        markers.extend(markers_from_element_selector(
            &part.element_selector,
            &plan.mesh.element_markers,
        ));
    }
    markers
}

pub(crate) fn normalized_runtime_element_markers(plan: &FemPlanIR) -> Result<Vec<u32>, RunError> {
    let markers = &plan.mesh.element_markers;
    if markers.is_empty() {
        return Ok(Vec::new());
    }

    let distinct_nonzero = markers
        .iter()
        .copied()
        .filter(|marker| *marker != 0)
        .collect::<BTreeSet<_>>();
    let has_air = markers.contains(&0);

    if !plan.region_materials.is_empty() {
        let magnetic_markers = plan
            .region_materials
            .iter()
            .map(|region| region.element_marker)
            .collect::<BTreeSet<_>>();
        if magnetic_markers.contains(&0) {
            return Err(RunError {
                message: "invalid FEM plan: region_materials must not use element_marker=0 for magnetic regions"
                    .to_string(),
            });
        }
        let unknown_nonzero = distinct_nonzero
            .difference(&magnetic_markers)
            .copied()
            .collect::<Vec<_>>();
        if !unknown_nonzero.is_empty() {
            return Err(RunError {
                message: format!(
                    "ambiguous FEM magnetic region contract: mesh contains non-zero element markers {:?} \
                     that are not declared in region_materials. Refusing to guess which regions are magnetic.",
                    unknown_nonzero
                ),
            });
        }
        return Ok(markers
            .iter()
            .map(|marker| u32::from(magnetic_markers.contains(marker)))
            .collect());
    }

    if distinct_nonzero.len() > 1 {
        let mut inferred_magnetic_markers = magnetic_markers_from_object_segments(plan);
        inferred_magnetic_markers.extend(magnetic_markers_from_mesh_parts(plan));
        if !inferred_magnetic_markers.is_empty() {
            let unknown_nonzero = distinct_nonzero
                .difference(&inferred_magnetic_markers)
                .copied()
                .collect::<Vec<_>>();
            if unknown_nonzero.is_empty() {
                return Ok(markers
                    .iter()
                    .map(|marker| u32::from(inferred_magnetic_markers.contains(marker)))
                    .collect());
            }
            return Err(RunError {
                message: format!(
                    "ambiguous FEM magnetic region contract: mesh contains non-zero element markers {:?} \
                     that are not covered by object_segments/mesh_parts-inferred magnetic markers {:?}. \
                     Refusing to guess which regions are magnetic.",
                    unknown_nonzero, inferred_magnetic_markers
                ),
            });
        }
        return Err(RunError {
            message: format!(
                "ambiguous FEM magnetic region contract: mesh uses multiple non-zero element markers {:?} \
                 without region_materials. Refusing to guess which regions are magnetic.",
                distinct_nonzero
            ),
        });
    }

    if has_air && !distinct_nonzero.is_empty() {
        Ok(markers
            .iter()
            .map(|marker| u32::from(*marker != 0))
            .collect())
    } else {
        Ok(vec![1; markers.len()])
    }
}

pub(crate) fn normalized_fem_plan_for_runtime(plan: &FemPlanIR) -> Result<FemPlanIR, RunError> {
    let normalized_markers = normalized_runtime_element_markers(plan)?;
    let mut normalized = plan.clone();
    normalized.mesh.element_markers = normalized_markers;
    Ok(normalized)
}
