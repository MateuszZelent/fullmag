//! Grid resampling, preview math, and vector field utilities.

use crate::types::*;
use fullmag_quantities::{quantity_spec, QuantityShape as QuantityKind};
use fullmag_runner::{FemMeshPayload, LivePreviewField};
use serde_json::Value;

const AIR_OBJECT_SEGMENT_ID: &str = "__air__";

pub(crate) fn live_step_metric_value(step: &StepUpdateView, metric_key: &str) -> Option<f64> {
    match metric_key {
        "e_ex" => Some(step.e_ex),
        "e_demag" => Some(step.e_demag),
        "e_ext" => Some(step.e_ext),
        "e_ani" => Some(step.e_ani),
        "e_dmi" => Some(step.e_dmi),
        "e_total" => Some(step.e_total),
        _ => None,
    }
}

pub(crate) fn display_kind_for_quantity(quantity: &str) -> &'static str {
    quantity_spec(quantity)
        .map(|spec| spec.shape.as_api_kind())
        .unwrap_or(QuantityKind::VectorField.as_api_kind())
}

pub(crate) fn normalize_preview_component(component: &str) -> &str {
    match component {
        "x" | "y" | "z" => component,
        _ => "3D",
    }
}

pub(crate) fn quantity_unit(quantity: &str) -> &'static str {
    fullmag_runner::quantities::quantity_unit(quantity)
}

pub(crate) fn quantity_spatial_domain(quantity: &str) -> &'static str {
    fullmag_runner::quantities::quantity_spatial_domain(quantity)
}

pub(crate) fn current_vector_field(
    current: &SessionStateResponse,
    quantity: &str,
) -> Option<(Vec<[f64; 3]>, [usize; 3])> {
    current
        .latest_fields
        .get(quantity)
        .and_then(parse_field_value)
}

pub(crate) fn mesh_preview_active_mask(mesh: &FemMeshPayload, quantity: &str) -> Option<Vec<bool>> {
    if quantity_spatial_domain(quantity) != "magnetic_only" {
        return None;
    }
    if mesh.element_markers.len() == mesh.elements.len() && !mesh.elements.is_empty() {
        let mut active_mask = vec![false; mesh.nodes.len()];
        for (element_index, element) in mesh.elements.iter().enumerate() {
            if mesh.element_markers[element_index] == 0 {
                continue;
            }
            for &node_index in element {
                let Some(active) = active_mask.get_mut(node_index as usize) else {
                    continue;
                };
                *active = true;
            }
        }
        return active_mask
            .iter()
            .any(|active| *active)
            .then_some(active_mask);
    }
    if !mesh.mesh_parts.is_empty() {
        let mut active_mask = vec![false; mesh.nodes.len()];
        for part in &mesh.mesh_parts {
            if part.role != "magnetic_object" {
                continue;
            }
            if !part.node_indices.is_empty() {
                for node_index in &part.node_indices {
                    let Some(active) = active_mask.get_mut(*node_index as usize) else {
                        continue;
                    };
                    *active = true;
                }
                continue;
            }
            let start = usize::try_from(part.node_start).ok()?;
            let count = usize::try_from(part.node_count).ok()?;
            let end = start.saturating_add(count).min(active_mask.len());
            if start >= end {
                continue;
            }
            active_mask[start..end].fill(true);
        }
        return active_mask
            .iter()
            .any(|active| *active)
            .then_some(active_mask);
    }
    let mut active_mask = vec![false; mesh.nodes.len()];
    for segment in &mesh.object_segments {
        if segment.object_id == AIR_OBJECT_SEGMENT_ID {
            continue;
        }
        let start = usize::try_from(segment.node_start).ok()?;
        let count = usize::try_from(segment.node_count).ok()?;
        let end = start.saturating_add(count).min(active_mask.len());
        if start >= end {
            continue;
        }
        active_mask[start..end].fill(true);
    }
    active_mask
        .iter()
        .any(|active| *active)
        .then_some(active_mask)
}

#[cfg(test)]
mod tests {
    use super::{
        mesh_preview_active_mask, quantity_spatial_domain, sampled_flat_grid_scalar_2d,
        AIR_OBJECT_SEGMENT_ID,
    };
    use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload, FemMeshPayload};

    fn test_mesh(
        nodes: Vec<[f64; 3]>,
        object_segments: Vec<FemMeshObjectSegment>,
        mesh_parts: Vec<FemMeshPartPayload>,
    ) -> FemMeshPayload {
        FemMeshPayload {
            mesh_name: "test_mesh".to_string(),
            mesh_id: "test_mesh:gen0".to_string(),
            nodes,
            elements: Vec::new(),
            element_markers: Vec::new(),
            boundary_faces: Vec::new(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments,
            mesh_parts,
            domain_mesh_mode: None,
            domain_frame: None,
            generation_id: Some("gen0".to_string()),
            per_domain_quality: Default::default(),
        }
    }

    #[test]
    fn quantity_spatial_domain_marks_magnetization_as_magnetic_only() {
        assert_eq!(quantity_spatial_domain("m"), "magnetic_only");
        assert_eq!(quantity_spatial_domain("H_demag"), "full_domain");
        assert_eq!(quantity_spatial_domain("H_eff"), "full_domain");
        assert_eq!(quantity_spatial_domain("H_ext"), "full_domain");
        assert_eq!(quantity_spatial_domain("H_ex"), "magnetic_only");
        assert_eq!(quantity_spatial_domain("H_ani"), "magnetic_only");
        assert_eq!(quantity_spatial_domain("H_dmi"), "magnetic_only");
    }

    #[test]
    fn flat_grid_scalar_preview_preserves_scalar_values_as_heatmap_points() {
        let sampled = sampled_flat_grid_scalar_2d(&[1.0, 2.0, 3.0, 4.0], [2, 2, 1]);

        assert_eq!(
            sampled,
            vec![
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 2.0],
                [0.0, 1.0, 3.0],
                [1.0, 1.0, 4.0]
            ]
        );
    }

    #[test]
    fn mesh_preview_active_mask_uses_object_segments_for_m() {
        let mesh = test_mesh(
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
                [2.0, 1.0, 0.0],
            ],
            vec![FemMeshObjectSegment {
                object_id: "flower".to_string(),
                geometry_id: Some("flower_geom".to_string()),
                node_start: 0,
                node_count: 4,
                element_start: 0,
                element_count: 0,
                boundary_face_start: 0,
                boundary_face_count: 0,
            }],
            Vec::new(),
        );

        assert_eq!(
            mesh_preview_active_mask(&mesh, "m"),
            Some(vec![true, true, true, true, false, false])
        );
        assert_eq!(mesh_preview_active_mask(&mesh, "H_demag"), None);
    }

    #[test]
    fn mesh_preview_active_mask_ignores_air_segment() {
        let mesh = test_mesh(
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
                [2.0, 1.0, 0.0],
            ],
            vec![
                FemMeshObjectSegment {
                    object_id: "flower".to_string(),
                    geometry_id: Some("flower_geom".to_string()),
                    node_start: 0,
                    node_count: 4,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                },
                FemMeshObjectSegment {
                    object_id: AIR_OBJECT_SEGMENT_ID.to_string(),
                    geometry_id: None,
                    node_start: 4,
                    node_count: 2,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                },
            ],
            Vec::new(),
        );

        assert_eq!(
            mesh_preview_active_mask(&mesh, "m"),
            Some(vec![true, true, true, true, false, false])
        );
    }

    #[test]
    fn mesh_preview_active_mask_uses_mesh_parts_before_legacy_segments() {
        let mesh = test_mesh(
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
                [2.0, 1.0, 0.0],
            ],
            Vec::new(),
            vec![
                FemMeshPartPayload {
                    id: "mag:flower".to_string(),
                    label: "Flower".to_string(),
                    role: "magnetic_object".to_string(),
                    object_id: Some("flower".to_string()),
                    geometry_id: Some("flower_geom".to_string()),
                    material_id: None,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                    node_start: 0,
                    node_count: 4,
                    boundary_face_indices: Vec::new(),
                    node_indices: Vec::new(),
                    surface_faces: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                },
                FemMeshPartPayload {
                    id: "air".to_string(),
                    label: "Air".to_string(),
                    role: "air".to_string(),
                    object_id: None,
                    geometry_id: None,
                    material_id: None,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                    node_start: 4,
                    node_count: 2,
                    boundary_face_indices: Vec::new(),
                    node_indices: Vec::new(),
                    surface_faces: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                },
            ],
        );

        assert_eq!(
            mesh_preview_active_mask(&mesh, "m"),
            Some(vec![true, true, true, true, false, false])
        );
    }
}

pub(crate) fn cached_preview_field_owned(
    current: &SessionStateResponse,
    quantity: &str,
) -> Option<LivePreviewField> {
    current.preview_cache.get(quantity).cloned()
}

pub(crate) fn cached_display_fields_match_selection(
    fields: &[LivePreviewField],
    display_selection: &CurrentDisplaySelection,
) -> bool {
    if matches!(
        display_selection.selection.kind,
        fullmag_runner::DisplayKind::GlobalScalar
    ) {
        return false;
    }
    fields
        .iter()
        .any(|field| field.quantity == display_selection.selection.quantity)
}

pub(crate) fn parse_field_value(raw: &Value) -> Option<(Vec<[f64; 3]>, [usize; 3])> {
    let grid = raw
        .get("layout")?
        .get("grid_cells")?
        .as_array()
        .and_then(|grid| {
            if grid.len() == 3 {
                Some([
                    grid[0].as_u64()? as usize,
                    grid[1].as_u64()? as usize,
                    grid[2].as_u64()? as usize,
                ])
            } else {
                None
            }
        })?;
    let values = raw.get("values")?.as_array()?;
    let vectors = values
        .iter()
        .filter_map(|value| {
            let vector = value.as_array()?;
            if vector.len() < 3 {
                return None;
            }
            Some([
                vector[0].as_f64()?,
                vector[1].as_f64()?,
                vector[2].as_f64()?,
            ])
        })
        .collect::<Vec<_>>();
    Some((vectors, grid))
}

pub(crate) fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|vector| [vector[0], vector[1], vector[2]])
        .collect()
}

pub(crate) fn component_min_max(values: &[[f64; 3]], component: &str) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for [x, y, z] in values.iter().copied() {
        let value = match component {
            "x" => x,
            "y" => y,
            "z" => z,
            _ => (x * x + y * y + z * z).sqrt(),
        };
        min = min.min(value);
        max = max.max(value);
    }
    (min, max)
}

pub(crate) fn scalar_min_max(values: &[[f64; 3]]) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for point in values {
        min = min.min(point[2]);
        max = max.max(point[2]);
    }
    (min, max)
}

pub(crate) fn candidate_preview_sizes(full: usize) -> Vec<usize> {
    let mut sizes = vec![full.max(1)];
    let mut current = full.max(1);
    while current > 1 {
        current = current.div_ceil(2);
        if sizes.last().copied() != Some(current) {
            sizes.push(current);
        }
    }
    sizes
}

pub(crate) fn fit_preview_grid_3d(
    requested_x: usize,
    requested_y: usize,
    full_z: usize,
    max_points: usize,
) -> (usize, usize, usize, bool) {
    if max_points == 0 {
        return (requested_x.max(1), requested_y.max(1), 1, false);
    }
    let requested_x = requested_x.max(1);
    let requested_y = requested_y.max(1);
    let full_z = full_z.max(1);
    let total = requested_x
        .saturating_mul(requested_y)
        .saturating_mul(full_z);
    if total <= max_points {
        return (requested_x, requested_y, 1, false);
    }

    let scale = (max_points as f64 / total as f64).cbrt().clamp(0.0, 1.0);
    let mut applied_x = ((requested_x as f64 * scale).round() as usize).clamp(1, requested_x);
    let mut applied_y = ((requested_y as f64 * scale).round() as usize).clamp(1, requested_y);
    let target_z = ((full_z as f64 * scale).round() as usize).clamp(1, full_z);
    let mut stride = full_z.div_ceil(target_z).max(1);
    let mut preview_z = full_z.div_ceil(stride).max(1);

    while applied_x
        .saturating_mul(applied_y)
        .saturating_mul(preview_z)
        > max_points
    {
        let ratio_x = applied_x as f64 / requested_x as f64;
        let ratio_y = applied_y as f64 / requested_y as f64;
        let ratio_z = preview_z as f64 / full_z as f64;
        if ratio_x >= ratio_y && ratio_x >= ratio_z && applied_x > 1 {
            applied_x -= 1;
        } else if ratio_y >= ratio_z && applied_y > 1 {
            applied_y -= 1;
        } else {
            stride += 1;
            preview_z = full_z.div_ceil(stride).max(1);
        }
    }

    (applied_x, applied_y, stride, true)
}

pub(crate) fn fit_preview_grid_2d(
    requested_x: usize,
    requested_y: usize,
    effective_layers: usize,
    max_points: usize,
) -> (usize, usize, bool) {
    if max_points == 0 {
        return (requested_x.max(1), requested_y.max(1), false);
    }
    let requested_x = requested_x.max(1);
    let requested_y = requested_y.max(1);
    let effective_layers = effective_layers.max(1);
    let total = requested_x
        .saturating_mul(requested_y)
        .saturating_mul(effective_layers);
    if total <= max_points {
        return (requested_x, requested_y, false);
    }

    let scale = (max_points as f64 / total as f64).sqrt().clamp(0.0, 1.0);
    let mut applied_x = ((requested_x as f64 * scale).round() as usize).clamp(1, requested_x);
    let mut applied_y = ((requested_y as f64 * scale).round() as usize).clamp(1, requested_y);

    while applied_x
        .saturating_mul(applied_y)
        .saturating_mul(effective_layers)
        > max_points
    {
        let ratio_x = applied_x as f64 / requested_x as f64;
        let ratio_y = applied_y as f64 / requested_y as f64;
        if ratio_x >= ratio_y && applied_x > 1 {
            applied_x -= 1;
        } else if applied_y > 1 {
            applied_y -= 1;
        } else {
            break;
        }
    }

    (applied_x, applied_y, true)
}

pub(crate) fn choose_preview_size(requested: usize, possible: &[usize], full: usize) -> usize {
    if requested == 0 {
        return full.max(1);
    }
    possible
        .iter()
        .copied()
        .find(|size| *size <= requested)
        .unwrap_or(1)
}

pub(crate) fn resample_grid_vectors_3d(
    values: &[[f64; 3]],
    full: [usize; 3],
    preview: [usize; 3],
    z_stride: usize,
) -> Vec<[f64; 3]> {
    let [full_x, full_y, full_z] = full;
    let [preview_x, preview_y, preview_z] = preview;
    let mut out = Vec::with_capacity(preview_x * preview_y * preview_z);
    for pz in 0..preview_z {
        let z_start = (pz * z_stride).min(full_z.saturating_sub(1));
        let z_end = ((pz + 1) * z_stride).min(full_z);
        for py in 0..preview_y {
            let y_start = py * full_y / preview_y;
            let y_end = ((py + 1) * full_y / preview_y).max(y_start + 1).min(full_y);
            for px in 0..preview_x {
                let x_start = px * full_x / preview_x;
                let x_end = ((px + 1) * full_x / preview_x).max(x_start + 1).min(full_x);
                let mut accum = [0.0, 0.0, 0.0];
                let mut count = 0.0;
                for z in z_start..z_end {
                    for y in y_start..y_end {
                        for x in x_start..x_end {
                            let vector = values[(z * full_y + y) * full_x + x];
                            accum[0] += vector[0];
                            accum[1] += vector[1];
                            accum[2] += vector[2];
                            count += 1.0;
                        }
                    }
                }
                out.push([accum[0] / count, accum[1] / count, accum[2] / count]);
            }
        }
    }
    out
}

pub(crate) fn resample_grid_scalar_2d(
    values: &[[f64; 3]],
    full: [usize; 3],
    preview: [usize; 2],
    component: &str,
    layer: usize,
    all_layers: bool,
) -> Vec<[f64; 3]> {
    let [full_x, full_y, full_z] = full;
    let [preview_x, preview_y] = preview;
    let z_start = if all_layers {
        0
    } else {
        layer.min(full_z.saturating_sub(1))
    };
    let z_end = if all_layers { full_z } else { z_start + 1 };
    let component_index = match component {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => 2,
    };
    let mut out = Vec::with_capacity(preview_x * preview_y);
    for py in 0..preview_y {
        let y_start = py * full_y / preview_y;
        let y_end = ((py + 1) * full_y / preview_y).max(y_start + 1).min(full_y);
        for px in 0..preview_x {
            let x_start = px * full_x / preview_x;
            let x_end = ((px + 1) * full_x / preview_x).max(x_start + 1).min(full_x);
            let mut accum = 0.0;
            let mut count = 0.0;
            for z in z_start..z_end {
                for y in y_start..y_end {
                    for x in x_start..x_end {
                        accum += values[(z * full_y + y) * full_x + x][component_index];
                        count += 1.0;
                    }
                }
            }
            out.push([px as f64, py as f64, accum / count]);
        }
    }
    out
}

pub(crate) fn sampled_grid_scalar_2d(
    values: &[[f64; 3]],
    preview_grid: [usize; 3],
    component: &str,
) -> Vec<[f64; 3]> {
    let component_index = match component {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => 2,
    };
    let mut out = Vec::with_capacity(preview_grid[0] * preview_grid[1]);
    for py in 0..preview_grid[1] {
        for px in 0..preview_grid[0] {
            let index = py * preview_grid[0] + px;
            let value = values
                .get(index)
                .map(|vector| vector[component_index])
                .unwrap_or(0.0);
            out.push([px as f64, py as f64, value]);
        }
    }
    out
}

pub(crate) fn sampled_flat_grid_scalar_2d(
    values: &[f64],
    preview_grid: [usize; 3],
) -> Vec<[f64; 3]> {
    let mut out = Vec::with_capacity(preview_grid[0] * preview_grid[1]);
    for py in 0..preview_grid[1] {
        for px in 0..preview_grid[0] {
            let index = py * preview_grid[0] + px;
            let value = values.get(index).copied().unwrap_or(0.0);
            out.push([px as f64, py as f64, value]);
        }
    }
    out
}
