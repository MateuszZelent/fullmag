//! Display mutation endpoints.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::display::DisplayUpdate;
use crate::schemas::status::{DisplaySelection, DisplayViewMode, FieldComponent};
use crate::types::{AppState, CurrentDisplaySelection, DisplayPresentationState};
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
    let mut presentation = state.current_display_presentation.write().await;

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
    if let Some(colormap) = update.colormap {
        presentation.colormap = colormap;
    }
    if let Some(contrast_min) = update.contrast_min {
        presentation.contrast_min = Some(contrast_min);
    }
    if let Some(contrast_max) = update.contrast_max {
        presentation.contrast_max = Some(contrast_max);
    }
    if let Some(vector_glyphs) = update.vector_glyphs {
        presentation.vector_glyphs = vector_glyphs;
    }
    sel.selection.canonicalize();

    sel.revision = sel.revision.wrapping_add(1);
    let response = build_display_selection_response(&sel, &presentation);

    Ok(Json(response))
}

pub(crate) fn build_display_selection_response(
    selection: &CurrentDisplaySelection,
    presentation: &DisplayPresentationState,
) -> DisplaySelection {
    DisplaySelection {
        active_quantity_id: selection.selection.quantity.clone(),
        view_mode: match selection.selection.view_mode {
            RunnerDisplayViewMode::TwoD => DisplayViewMode::TwoD,
            RunnerDisplayViewMode::ThreeD => DisplayViewMode::ThreeD,
        },
        field_component: match selection.selection.field_component {
            DisplayFieldComponent::X => FieldComponent::X,
            DisplayFieldComponent::Y => FieldComponent::Y,
            DisplayFieldComponent::Z => FieldComponent::Z,
            DisplayFieldComponent::Magnitude => FieldComponent::Magnitude,
        },
        colormap: presentation.colormap.clone(),
        auto_contrast: selection.selection.auto_scale_enabled,
        contrast_min: presentation.contrast_min,
        contrast_max: presentation.contrast_max,
        vector_glyphs: presentation.vector_glyphs,
        vector_density: selection.selection.every_n,
        slice_mode: if selection.selection.all_layers {
            "all".into()
        } else {
            "single".into()
        },
        slice_layer: selection.selection.layer as i32,
        max_points: selection.selection.max_points,
        x_chosen_size: selection.selection.x_chosen_size,
        y_chosen_size: selection.selection.y_chosen_size,
    }
}
