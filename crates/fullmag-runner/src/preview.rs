use crate::quantities::{
    normalize_quantity_id, normalized_quantity_name, quantity_spatial_domain, quantity_unit,
    QuantityId,
};
use crate::types::{LivePreviewField, LivePreviewRequest, StateObservables};
use fullmag_ir::MeshIR;

#[derive(Debug, Clone)]
pub(crate) struct GridPreviewPlan {
    pub preview_grid: [u32; 3],
    pub original_grid: [u32; 3],
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
    pub applied_x_chosen_size: u32,
    pub applied_y_chosen_size: u32,
    pub applied_layer_stride: u32,
    pub z_origin: u32,
    pub auto_downscaled: bool,
    pub auto_downscale_message: Option<String>,
}

pub(crate) fn select_observables<'a>(
    observables: &'a StateObservables,
    quantity: &str,
) -> Result<&'a [[f64; 3]], crate::RunError> {
    match normalize_quantity_id(quantity)? {
        QuantityId::HEx => Ok(observables.exchange_field.as_slice()),
        QuantityId::HDemag => Ok(observables.demag_field.as_slice()),
        QuantityId::HAnt => Ok(observables.antenna_field.as_slice()),
        QuantityId::HExt => Ok(observables.external_field.as_slice()),
        QuantityId::HEff => Ok(observables.effective_field.as_slice()),
        QuantityId::M => Ok(observables.magnetization.as_slice()),
        other => Err(crate::RunError {
            message: format!(
                "preview quantity '{}' is not available in this execution path",
                other.as_str()
            ),
        }),
    }
}

pub(crate) fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|vector| [vector[0], vector[1], vector[2]])
        .collect()
}

pub(crate) fn plan_grid_preview(
    request: &LivePreviewRequest,
    original_grid: [u32; 3],
) -> GridPreviewPlan {
    let [full_x_u32, full_y_u32, full_z_u32] = original_grid;
    let full_x = full_x_u32.max(1) as usize;
    let full_y = full_y_u32.max(1) as usize;
    let full_z = full_z_u32.max(1) as usize;
    let x_possible_sizes = candidate_preview_sizes(full_x);
    let y_possible_sizes = candidate_preview_sizes(full_y);
    let requested_x =
        choose_preview_size(request.x_chosen_size as usize, &x_possible_sizes, full_x);
    let requested_y =
        choose_preview_size(request.y_chosen_size as usize, &y_possible_sizes, full_y);

    if request.component == "3D" {
        let (applied_x, applied_y, stride, auto_downscaled) = if request.auto_scale_enabled {
            fit_preview_grid_3d(
                requested_x,
                requested_y,
                full_z,
                request.max_points as usize,
            )
        } else {
            (requested_x, requested_y, 1, false)
        };
        let preview_z = full_z.div_ceil(stride).max(1);
        let max_points = request.max_points as usize;
        let auto_downscale_message = auto_downscaled.then(|| {
            format!(
                "Preview auto-fit from {}x{}x{} to {}x{}x{} within {} points",
                full_x, full_y, full_z, applied_x, applied_y, preview_z, max_points
            )
        });
        return GridPreviewPlan {
            preview_grid: [applied_x as u32, applied_y as u32, preview_z as u32],
            original_grid,
            x_chosen_size: requested_x as u32,
            y_chosen_size: requested_y as u32,
            applied_x_chosen_size: applied_x as u32,
            applied_y_chosen_size: applied_y as u32,
            applied_layer_stride: stride as u32,
            z_origin: 0,
            auto_downscaled,
            auto_downscale_message,
        };
    }

    let effective_layers = if request.all_layers { full_z } else { 1 };
    let (applied_x, applied_y, auto_downscaled) = if request.auto_scale_enabled {
        fit_preview_grid_2d(
            requested_x,
            requested_y,
            effective_layers,
            request.max_points as usize,
        )
    } else {
        (requested_x, requested_y, false)
    };
    let max_points = request.max_points as usize;
    let auto_downscale_message = auto_downscaled.then(|| {
        format!(
            "Preview auto-fit from {}x{} to {}x{} within {} points",
            full_x, full_y, applied_x, applied_y, max_points
        )
    });
    GridPreviewPlan {
        preview_grid: [applied_x as u32, applied_y as u32, 1],
        original_grid,
        x_chosen_size: requested_x as u32,
        y_chosen_size: requested_y as u32,
        applied_x_chosen_size: applied_x as u32,
        applied_y_chosen_size: applied_y as u32,
        applied_layer_stride: if request.all_layers { full_z as u32 } else { 1 },
        z_origin: if request.all_layers {
            0
        } else {
            request.layer.min(full_z_u32.saturating_sub(1))
        },
        auto_downscaled,
        auto_downscale_message,
    }
}

pub(crate) fn resample_grid_vectors(values: &[[f64; 3]], plan: &GridPreviewPlan) -> Vec<[f64; 3]> {
    let [full_x, full_y, full_z] = plan.original_grid.map(|value| value.max(1) as usize);
    let [preview_x, preview_y, preview_z] = plan.preview_grid.map(|value| value.max(1) as usize);
    let z_stride = plan.applied_layer_stride.max(1) as usize;
    let z_origin = plan.z_origin as usize;
    let mut out = Vec::with_capacity(preview_x * preview_y * preview_z);
    for pz in 0..preview_z {
        let z_start = (z_origin + pz * z_stride).min(full_z.saturating_sub(1));
        let z_end = (z_origin + (pz + 1) * z_stride)
            .min(full_z)
            .max(z_start + 1);
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

/// Resample a full-grid boolean mask to preview-grid dimensions.
/// A preview cell is active if ANY original cell in its block is active.
pub(crate) fn resample_grid_mask(mask: &[bool], plan: &GridPreviewPlan) -> Vec<bool> {
    let [full_x, full_y, full_z] = plan.original_grid.map(|v| v.max(1) as usize);
    let [preview_x, preview_y, preview_z] = plan.preview_grid.map(|v| v.max(1) as usize);
    let z_stride = plan.applied_layer_stride.max(1) as usize;
    let z_origin = plan.z_origin as usize;
    let mut out = Vec::with_capacity(preview_x * preview_y * preview_z);
    for pz in 0..preview_z {
        let z_start = (z_origin + pz * z_stride).min(full_z.saturating_sub(1));
        let z_end = (z_origin + (pz + 1) * z_stride)
            .min(full_z)
            .max(z_start + 1);
        for py in 0..preview_y {
            let y_start = py * full_y / preview_y;
            let y_end = ((py + 1) * full_y / preview_y).max(y_start + 1).min(full_y);
            for px in 0..preview_x {
                let x_start = px * full_x / preview_x;
                let x_end = ((px + 1) * full_x / preview_x).max(x_start + 1).min(full_x);
                let mut any_active = false;
                'block: for z in z_start..z_end {
                    for y in y_start..y_end {
                        for x in x_start..x_end {
                            let idx = (z * full_y + y) * full_x + x;
                            if idx < mask.len() && mask[idx] {
                                any_active = true;
                                break 'block;
                            }
                        }
                    }
                }
                out.push(any_active);
            }
        }
    }
    out
}

pub(crate) fn build_grid_preview_field(
    request: &LivePreviewRequest,
    values: &[[f64; 3]],
    original_grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> LivePreviewField {
    let quantity = normalized_quantity_name(&request.quantity).unwrap_or("m");
    let plan = plan_grid_preview(request, original_grid);
    let sampled = resample_grid_vectors(values, &plan);
    let resampled_mask = active_mask.map(|mask| resample_grid_mask(mask, &plan));
    build_grid_preview_field_from_plan(request, &plan, &sampled, quantity, resampled_mask)
}

pub(crate) fn build_grid_preview_field_from_plan(
    request: &LivePreviewRequest,
    plan: &GridPreviewPlan,
    sampled: &[[f64; 3]],
    quantity: &str,
    active_mask: Option<Vec<bool>>,
) -> LivePreviewField {
    build_grid_preview_field_from_flat_plan(
        request,
        plan,
        flatten_vectors(sampled),
        quantity,
        active_mask,
    )
}

pub(crate) fn build_grid_preview_field_from_flat_plan(
    request: &LivePreviewRequest,
    plan: &GridPreviewPlan,
    vector_field_values: Vec<f64>,
    quantity: &str,
    active_mask: Option<Vec<bool>>,
) -> LivePreviewField {
    LivePreviewField {
        config_revision: request.revision,
        quantity: quantity.to_string(),
        unit: quantity_unit(quantity).to_string(),
        spatial_kind: "grid".to_string(),
        quantity_domain: quantity_spatial_domain(quantity).to_string(),
        preview_grid: plan.preview_grid,
        original_grid: plan.original_grid,
        vector_field_values,
        x_chosen_size: plan.x_chosen_size,
        y_chosen_size: plan.y_chosen_size,
        applied_x_chosen_size: plan.applied_x_chosen_size,
        applied_y_chosen_size: plan.applied_y_chosen_size,
        applied_layer_stride: plan.applied_layer_stride,
        auto_downscaled: plan.auto_downscaled,
        auto_downscale_message: plan.auto_downscale_message.clone(),
        active_mask,
    }
}

pub(crate) fn mesh_quantity_active_mask(quantity: &str, mesh: &MeshIR) -> Option<Vec<bool>> {
    let domain = quantity_spatial_domain(quantity);
    if domain != "magnetic_only" {
        return None;
    }
    let magnetic_element_mask = magnetic_element_mask_from_markers(&mesh.element_markers);
    let mut active_mask = vec![false; mesh.nodes.len()];
    for (element_index, element) in mesh.elements.iter().enumerate() {
        if !magnetic_element_mask
            .get(element_index)
            .copied()
            .unwrap_or(true)
        {
            continue;
        }
        for &node_index in element {
            if let Some(active) = active_mask.get_mut(node_index as usize) {
                *active = true;
            }
        }
    }
    Some(active_mask)
}

fn magnetic_element_mask_from_markers(markers: &[u32]) -> Vec<bool> {
    let has_air = markers.iter().any(|&marker| marker == 0);
    let has_magnetic = markers.iter().any(|&marker| marker != 0);
    if has_air && has_magnetic {
        markers.iter().map(|&marker| marker != 0).collect()
    } else {
        vec![true; markers.len()]
    }
}

pub(crate) fn build_mesh_preview_field_with_active_mask(
    request: &LivePreviewRequest,
    values: &[[f64; 3]],
    active_mask: Option<Vec<bool>>,
) -> LivePreviewField {
    let quantity = normalized_quantity_name(&request.quantity).unwrap_or("m");
    LivePreviewField {
        config_revision: request.revision,
        quantity: quantity.to_string(),
        unit: quantity_unit(quantity).to_string(),
        spatial_kind: "mesh".to_string(),
        quantity_domain: quantity_spatial_domain(quantity).to_string(),
        preview_grid: [values.len() as u32, 1, 1],
        original_grid: [0, 0, 0],
        vector_field_values: flatten_vectors(values),
        x_chosen_size: 0,
        y_chosen_size: 0,
        applied_x_chosen_size: 0,
        applied_y_chosen_size: 0,
        applied_layer_stride: 1,
        auto_downscaled: false,
        auto_downscale_message: None,
        active_mask,
    }
}

fn candidate_preview_sizes(full: usize) -> Vec<usize> {
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

fn fit_preview_grid_3d(
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
        // When preview_z is already 1, increasing stride won't help — skip
        // directly to reducing the larger XY dimension.
        let can_reduce_z = preview_z > 1;
        if can_reduce_z && ratio_z >= ratio_x && ratio_z >= ratio_y {
            stride += 1;
            preview_z = full_z.div_ceil(stride).max(1);
        } else if ratio_x >= ratio_y && applied_x > 1 {
            applied_x -= 1;
        } else if applied_y > 1 {
            applied_y -= 1;
        } else {
            // All dimensions are at their minimum — break to avoid
            // an infinite loop (can happen when max_points < full_z).
            break;
        }
    }

    (applied_x, applied_y, stride, true)
}

fn fit_preview_grid_2d(
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

fn choose_preview_size(requested: usize, possible: &[usize], full: usize) -> usize {
    if requested == 0 {
        return full.max(1);
    }
    possible
        .iter()
        .copied()
        .find(|size| *size <= requested)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::mesh_quantity_active_mask;
    use fullmag_ir::MeshIR;

    fn test_mesh(element_markers: Vec<u32>) -> MeshIR {
        MeshIR {
            mesh_name: "test".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
            ],
            elements: vec![[0, 1, 2, 3], [1, 2, 3, 4]],
            element_markers,
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: Default::default(),
        }
    }

    #[test]
    fn mesh_quantity_active_mask_treats_all_zero_markers_as_fully_magnetic() {
        let mesh = test_mesh(vec![0, 0]);
        assert_eq!(
            mesh_quantity_active_mask("m", &mesh),
            Some(vec![true, true, true, true, true]),
        );
    }

    #[test]
    fn mesh_quantity_active_mask_treats_all_nonzero_markers_as_fully_magnetic() {
        let mesh = test_mesh(vec![2, 2]);
        assert_eq!(
            mesh_quantity_active_mask("m", &mesh),
            Some(vec![true, true, true, true, true]),
        );
    }

    #[test]
    fn mesh_quantity_active_mask_excludes_air_only_when_air_and_magnetic_are_mixed() {
        let mesh = test_mesh(vec![1, 0]);
        assert_eq!(
            mesh_quantity_active_mask("m", &mesh),
            Some(vec![true, true, true, true, false]),
        );
    }
}
