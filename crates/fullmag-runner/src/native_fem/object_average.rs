//! Object membership for native DG0 moment reductions. No field reduction is
//! performed here: element ownership is resolved once and passed to the ABI.

use crate::types::RunError;
use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector, FemPlanIR};
use std::collections::{BTreeSet, HashMap};

fn ids_match(left: &str, right: &str) -> bool {
    left.strip_suffix("_geom").unwrap_or(left) == right.strip_suffix("_geom").unwrap_or(right)
}

fn checked_range(
    start: u32,
    count: u32,
    available: usize,
) -> Result<std::ops::Range<u32>, RunError> {
    let end = start
        .checked_add(count)
        .filter(|end| *end as usize <= available)
        .ok_or_else(|| RunError {
            message: "FEM object average element range exceeds the canonical mesh".to_string(),
        })?;
    Ok(start..end)
}

pub(super) fn object_element_indices(
    plan: &FemPlanIR,
) -> Result<HashMap<String, Vec<u32>>, RunError> {
    let count = u32::try_from(plan.mesh.cell_count()).map_err(|_| RunError {
        message: "FEM object average element indices exceed the u32 ABI".to_string(),
    })?;
    if plan.object_segments.is_empty() {
        return Ok(HashMap::from([("free".to_string(), (0..count).collect())]));
    }
    // Build a marker index once, rather than scanning the mesh for every
    // object/region. Authored marker values need not be dense or small.
    let mut elements_by_marker: HashMap<u32, Vec<u32>> = HashMap::new();
    if plan.mesh_parts.iter().any(|part| {
        matches!(
            &part.element_selector,
            FemMeshPartSelector::ElementMarkerSet { .. }
        )
    }) {
        for (index, marker) in plan.mesh.element_markers.iter().enumerate() {
            elements_by_marker
                .entry(*marker)
                .or_default()
                .push(index as u32);
        }
    }
    let mut by_object: HashMap<String, BTreeSet<u32>> = HashMap::new();
    for segment in &plan.object_segments {
        if segment.object_id == "__air__" {
            continue;
        }
        let indices = by_object.entry(segment.object_id.clone()).or_default();
        let mut has_part = false;
        for part in plan.mesh_parts.iter().filter(|part| {
            part.role == FemMeshPartRole::MagneticObject
                && (part
                    .object_id
                    .as_deref()
                    .is_some_and(|id| ids_match(id, &segment.object_id))
                    || part
                        .geometry_id
                        .as_deref()
                        .zip(segment.geometry_id.as_deref())
                        .is_some_and(|(a, b)| ids_match(a, b))
                    || ids_match(&part.id, &segment.object_id))
        }) {
            has_part = true;
            match &part.element_selector {
                FemMeshPartSelector::ElementRange {
                    start,
                    count: length,
                } => {
                    indices.extend(checked_range(*start, *length, count as usize)?);
                }
                FemMeshPartSelector::ElementMarkerSet { markers } => {
                    if markers.is_empty() {
                        return Err(RunError {
                            message: format!(
                                "FEM object average has an empty marker selector for '{}'",
                                part.id
                            ),
                        });
                    }
                    if plan.mesh.element_markers.len() != count as usize {
                        return Err(RunError {
                            message: "FEM object average marker selector requires canonical element markers".to_string(),
                        });
                    }
                    for marker in markers {
                        let elements = elements_by_marker.get(marker).ok_or_else(|| RunError {
                            message: format!("FEM object average marker {marker} for '{}' has no realized elements", part.id),
                        })?;
                        indices.extend(elements.iter().copied());
                    }
                }
                _ => {
                    return Err(RunError {
                        message: format!(
                            "FEM object average requires an element selector for '{}'",
                            part.id
                        ),
                    })
                }
            }
        }
        if !has_part {
            indices.extend(checked_range(
                segment.element_start,
                segment.element_count,
                count as usize,
            )?);
        }
    }
    Ok(by_object
        .into_iter()
        .map(|(id, indices)| (id, indices.into_iter().collect()))
        .collect())
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
impl super::NativeFemBackend {
    pub(super) fn average_m_for_elements(
        &self,
        indices: &[u32],
    ) -> Result<Option<[f64; 3]>, RunError> {
        if indices.is_empty() {
            return Ok(None);
        }
        let mut average = [0.0; 3];
        let rc = unsafe {
            super::ffi::fullmag_fem_backend_average_m_for_elements_f64(
                self.handle,
                indices.as_ptr(),
                indices.len() as u64,
                average.as_mut_ptr(),
                average.len() as u64,
            )
        };
        if rc != super::ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM native element-set average_m reduction failed"));
        }
        Ok(Some(average))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{FemMeshPartIR, FemObjectSegmentIR};

    fn segment(id: &str, start: u32, count: u32) -> FemObjectSegmentIR {
        FemObjectSegmentIR {
            object_id: id.into(),
            geometry_id: None,
            node_start: 0,
            node_count: 4,
            element_start: start,
            element_count: count,
            boundary_face_start: 0,
            boundary_face_count: 0,
        }
    }

    fn part(selector: FemMeshPartSelector) -> FemMeshPartIR {
        FemMeshPartIR {
            id: "part:body".into(),
            label: "body".into(),
            role: FemMeshPartRole::MagneticObject,
            object_id: Some("body".into()),
            geometry_id: None,
            material_id: None,
            element_selector: selector,
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 0 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 4 },
            boundary_face_indices: vec![],
            node_indices: vec![0, 1, 2, 3],
            facet_global_ordinals: vec![],
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        }
    }

    #[test]
    fn marker_ownership_excludes_foreign_elements_despite_shared_node_membership() {
        let mut plan = super::super::make_test_plan();
        // Membership-only fixture: all cell node sets are the same; only
        // canonical element ownership distinguishes the foreign cell.
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3]; 3]);
        plan.mesh.element_markers = vec![7, 9, 7];
        plan.object_segments = vec![segment("body", 0, 3)];
        plan.mesh_parts = vec![part(FemMeshPartSelector::ElementMarkerSet {
            markers: vec![7],
        })];
        assert_eq!(object_element_indices(&plan).unwrap()["body"], vec![0, 2]);
    }

    #[test]
    fn unions_all_object_parts_and_deduplicates_overlapping_ranges() {
        let mut plan = super::super::make_test_plan();
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3]; 3]);
        plan.object_segments = vec![segment("body", 0, 3)];
        plan.mesh_parts = vec![
            part(FemMeshPartSelector::ElementRange { start: 0, count: 1 }),
            part(FemMeshPartSelector::ElementRange { start: 2, count: 1 }),
            part(FemMeshPartSelector::ElementRange { start: 2, count: 1 }),
        ];
        assert_eq!(object_element_indices(&plan).unwrap()["body"], vec![0, 2]);
    }

    #[test]
    fn segment_fallback_preserves_element_ownership_and_excludes_air() {
        let mut plan = super::super::make_test_plan();
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3]; 3]);
        plan.mesh_parts.clear();
        plan.object_segments = vec![
            segment("body", 0, 1),
            segment("other", 1, 1),
            segment("__air__", 2, 1),
        ];
        let actual = object_element_indices(&plan).unwrap();
        assert_eq!(actual["body"], vec![0]);
        assert_eq!(actual["other"], vec![1]);
        assert_eq!(actual.len(), 2);
    }

    #[test]
    fn rejects_missing_markers_instead_of_averaging_a_partial_object() {
        let mut plan = super::super::make_test_plan();
        plan.mesh.element_markers = vec![7];
        plan.object_segments = vec![segment("body", 0, 1)];
        for markers in [vec![7, 9], vec![9]] {
            plan.mesh_parts = vec![part(FemMeshPartSelector::ElementMarkerSet { markers })];
            let error = object_element_indices(&plan).unwrap_err();
            assert!(error.message.contains("marker 9"), "{}", error.message);
        }
        plan.mesh_parts = vec![part(FemMeshPartSelector::ElementMarkerSet {
            markers: vec![],
        })];
        assert!(object_element_indices(&plan).is_err());
    }

    #[test]
    fn rejects_invalid_ownership_instead_of_falling_back_to_nodes() {
        let mut plan = super::super::make_test_plan();
        plan.mesh_parts.clear();
        plan.object_segments = vec![segment("body", u32::MAX, 2)];
        assert!(object_element_indices(&plan).is_err());
        plan.object_segments = vec![segment("body", 0, 2)];
        assert!(object_element_indices(&plan).is_err());
        plan.object_segments = vec![segment("body", 0, 1)];
        plan.mesh_parts = vec![part(FemMeshPartSelector::ElementMarkerSet {
            markers: vec![1],
        })];
        plan.mesh.element_markers.clear();
        assert!(object_element_indices(&plan).is_err());
        plan.mesh_parts[0].element_selector = FemMeshPartSelector::NodeRange { start: 0, count: 4 };
        assert!(object_element_indices(&plan).is_err());
    }
}
