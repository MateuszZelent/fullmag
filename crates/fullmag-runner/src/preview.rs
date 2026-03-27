use crate::types::{LivePreviewField, LivePreviewRequest, StateObservables};

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

pub(crate) fn normalize_quantity_id(requested: &str) -> &'static str {
    match requested {
        "H_ex" => "H_ex",
        "H_demag" => "H_demag",
        "H_ext" => "H_ext",
        "H_eff" => "H_eff",
        _ => "m",
    }
}

pub(crate) fn quantity_unit(quantity: &str) -> &'static str {
    match normalize_quantity_id(quantity) {
        "m" => "dimensionless",
        "H_ex" | "H_demag" | "H_ext" | "H_eff" => "A/m",
        _ => "",
    }
}

pub(crate) fn select_observables<'a>(
    observables: &'a StateObservables,
    quantity: &str,
) -> &'a [[f64; 3]] {
    match normalize_quantity_id(quantity) {
        "H_ex" => observables.exchange_field.as_slice(),
        "H_demag" => observables.demag_field.as_slice(),
        "H_ext" => observables.external_field.as_slice(),
        "H_eff" => observables.effective_field.as_slice(),
        _ => observables.magnetization.as_slice(),
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
        let mut applied_x = requested_x;
        let mut applied_y = requested_y;
        let mut stride = 1usize;
        let mut preview_z = full_z;
        let mut auto_downscaled = false;
        let max_points = request.max_points.max(1) as usize;
        while request.auto_scale_enabled
            && applied_x * applied_y * preview_z > max_points
            && (applied_x > 1 || applied_y > 1 || preview_z > 1)
        {
            auto_downscaled = true;
            if applied_x >= applied_y && applied_x > 1 {
                applied_x = next_smaller_size(applied_x, &x_possible_sizes);
            } else if applied_y > 1 {
                applied_y = next_smaller_size(applied_y, &y_possible_sizes);
            } else {
                stride += 1;
                preview_z = full_z.div_ceil(stride);
            }
        }
        let auto_downscale_message = auto_downscaled.then(|| {
            format!(
                "Preview auto-scaled from {}x{}x{} to {}x{}x{} to stay within {} points",
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

    let mut applied_x = requested_x;
    let mut applied_y = requested_y;
    let effective_layers = if request.all_layers { full_z } else { 1 };
    let mut auto_downscaled = false;
    let max_points = request.max_points.max(1) as usize;
    while request.auto_scale_enabled
        && applied_x * applied_y * effective_layers > max_points
        && (applied_x > 1 || applied_y > 1)
    {
        auto_downscaled = true;
        if applied_x >= applied_y && applied_x > 1 {
            applied_x = next_smaller_size(applied_x, &x_possible_sizes);
        } else if applied_y > 1 {
            applied_y = next_smaller_size(applied_y, &y_possible_sizes);
        }
    }
    let auto_downscale_message = auto_downscaled.then(|| {
        format!(
            "Preview auto-scaled from {}x{} to {}x{} to stay within {} points",
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
        applied_layer_stride: if request.all_layers {
            full_z as u32
        } else {
            1
        },
        z_origin: if request.all_layers {
            0
        } else {
            request.layer.min(full_z_u32.saturating_sub(1))
        },
        auto_downscaled,
        auto_downscale_message,
    }
}

pub(crate) fn resample_grid_vectors(
    values: &[[f64; 3]],
    plan: &GridPreviewPlan,
) -> Vec<[f64; 3]> {
    let [full_x, full_y, full_z] = plan.original_grid.map(|value| value.max(1) as usize);
    let [preview_x, preview_y, preview_z] = plan.preview_grid.map(|value| value.max(1) as usize);
    let z_stride = plan.applied_layer_stride.max(1) as usize;
    let z_origin = plan.z_origin as usize;
    let mut out = Vec::with_capacity(preview_x * preview_y * preview_z);
    for pz in 0..preview_z {
        let z_start = (z_origin + pz * z_stride).min(full_z.saturating_sub(1));
        let z_end = (z_origin + (pz + 1) * z_stride).min(full_z).max(z_start + 1);
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

pub(crate) fn build_grid_preview_field(
    request: &LivePreviewRequest,
    values: &[[f64; 3]],
    original_grid: [u32; 3],
) -> LivePreviewField {
    let quantity = normalize_quantity_id(&request.quantity);
    let plan = plan_grid_preview(request, original_grid);
    let sampled = resample_grid_vectors(values, &plan);
    build_grid_preview_field_from_plan(request, &plan, &sampled, quantity)
}

pub(crate) fn build_grid_preview_field_from_plan(
    request: &LivePreviewRequest,
    plan: &GridPreviewPlan,
    sampled: &[[f64; 3]],
    quantity: &str,
) -> LivePreviewField {
    LivePreviewField {
        config_revision: request.revision,
        quantity: quantity.to_string(),
        unit: quantity_unit(quantity).to_string(),
        spatial_kind: "grid".to_string(),
        preview_grid: plan.preview_grid,
        original_grid: plan.original_grid,
        vector_field_values: flatten_vectors(sampled),
        x_chosen_size: plan.x_chosen_size,
        y_chosen_size: plan.y_chosen_size,
        applied_x_chosen_size: plan.applied_x_chosen_size,
        applied_y_chosen_size: plan.applied_y_chosen_size,
        applied_layer_stride: plan.applied_layer_stride,
        auto_downscaled: plan.auto_downscaled,
        auto_downscale_message: plan.auto_downscale_message.clone(),
    }
}

pub(crate) fn build_mesh_preview_field(
    request: &LivePreviewRequest,
    values: &[[f64; 3]],
) -> LivePreviewField {
    let quantity = normalize_quantity_id(&request.quantity);
    LivePreviewField {
        config_revision: request.revision,
        quantity: quantity.to_string(),
        unit: quantity_unit(quantity).to_string(),
        spatial_kind: "mesh".to_string(),
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

fn next_smaller_size(current: usize, possible: &[usize]) -> usize {
    let index = possible
        .iter()
        .position(|size| *size == current)
        .unwrap_or(0);
    possible.get(index + 1).copied().unwrap_or(1)
}
