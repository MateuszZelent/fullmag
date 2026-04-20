//! Display mutation endpoints.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::display::DisplayUpdate;
use crate::schemas::status::{DisplaySelection, DisplayViewMode, FieldComponent};
use crate::types::AppState;
use fullmag_runner::{DisplayFieldComponent, DisplayViewMode as RunnerDisplayViewMode};

#[utoipa::path(
    put,
    path = "/v1/live/current/display",
    request_body = DisplayUpdate,
    responses(
        (status = 200, description = "Display updated", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "display"
)]
pub async fn update_display(
    State(state): State<Arc<AppState>>,
    Json(update): Json<DisplayUpdate>,
) -> Result<Json<DisplaySelection>, ApiError> {
    apply_display_update(state, update).await
}

#[utoipa::path(
    patch,
    path = "/v1/live/current/display",
    request_body = DisplayUpdate,
    responses(
        (status = 200, description = "Display patched", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "display"
)]
pub async fn patch_display(
    State(state): State<Arc<AppState>>,
    Json(update): Json<DisplayUpdate>,
) -> Result<Json<DisplaySelection>, ApiError> {
    apply_display_update(state, update).await
}

async fn apply_display_update(
    state: Arc<AppState>,
    update: DisplayUpdate,
) -> Result<Json<DisplaySelection>, ApiError> {
    let mut sel = state.current_display_selection.write().await;

    if let Some(q) = update.active_quantity_id {
        sel.selection.quantity = q;
    }
    if let Some(view_mode) = update.view_mode {
        sel.selection.view_mode = match view_mode {
            DisplayViewMode::TwoD => RunnerDisplayViewMode::TwoD,
            DisplayViewMode::ThreeD => RunnerDisplayViewMode::ThreeD,
        };
    }
    if let Some(field_component) = update.field_component {
        sel.selection.field_component = match field_component {
            FieldComponent::X => DisplayFieldComponent::X,
            FieldComponent::Y => DisplayFieldComponent::Y,
            FieldComponent::Z => DisplayFieldComponent::Z,
            FieldComponent::Magnitude => DisplayFieldComponent::Magnitude,
        };
    }
    if let Some(ac) = update.auto_contrast {
        sel.selection.auto_scale_enabled = ac;
    }
    if let Some(vd) = update.vector_density {
        sel.selection.every_n = vd;
    }
    if let Some(sl) = update.slice_layer {
        sel.selection.layer = sl as u32;
    }
    if let Some(sm) = update.slice_mode {
        sel.selection.all_layers = sm == "all";
    }
    if let Some(max_points) = update.max_points {
        sel.selection.max_points = max_points;
    }
    if let Some(x_chosen_size) = update.x_chosen_size {
        sel.selection.x_chosen_size = x_chosen_size;
    }
    if let Some(y_chosen_size) = update.y_chosen_size {
        sel.selection.y_chosen_size = y_chosen_size;
    }
    sel.selection.canonicalize();

    sel.revision = sel.revision.wrapping_add(1);
    let response = DisplaySelection {
        active_quantity_id: sel.selection.quantity.clone(),
        view_mode: match sel.selection.view_mode {
            RunnerDisplayViewMode::TwoD => DisplayViewMode::TwoD,
            RunnerDisplayViewMode::ThreeD => DisplayViewMode::ThreeD,
        },
        field_component: match sel.selection.field_component {
            DisplayFieldComponent::X => FieldComponent::X,
            DisplayFieldComponent::Y => FieldComponent::Y,
            DisplayFieldComponent::Z => FieldComponent::Z,
            DisplayFieldComponent::Magnitude => FieldComponent::Magnitude,
        },
        colormap: update.colormap.unwrap_or_else(|| "viridis".to_string()),
        auto_contrast: sel.selection.auto_scale_enabled,
        contrast_min: update.contrast_min,
        contrast_max: update.contrast_max,
        vector_glyphs: update.vector_glyphs.unwrap_or(true),
        vector_density: sel.selection.every_n,
        slice_mode: if sel.selection.all_layers {
            "all".into()
        } else {
            "single".into()
        },
        slice_layer: sel.selection.layer as i32,
        max_points: sel.selection.max_points,
        x_chosen_size: sel.selection.x_chosen_size,
        y_chosen_size: sel.selection.y_chosen_size,
    };

    Ok(Json(response))
}
