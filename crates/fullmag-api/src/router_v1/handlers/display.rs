//! Display mutation endpoints.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::display::DisplayPatch;
use crate::schemas::status::{DisplaySelection, DisplayViewMode, FieldComponent};
use crate::types::{AppState, CurrentDisplaySelection, DisplayPresentationState};
use fullmag_runner::{DisplayFieldComponent, DisplayViewMode as RunnerDisplayViewMode};

#[utoipa::path(
    get,
    path = "/v1/live/current/display",
    responses(
        (status = 200, description = "Current display selection", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "display"
)]
pub async fn get_display(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DisplaySelection>, ApiError> {
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    Ok(Json(build_display_selection_response(
        &selection,
        &presentation,
    )))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/display",
    request_body = DisplaySelection,
    responses(
        (status = 200, description = "Display replaced", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "display"
)]
pub async fn replace_display(
    State(state): State<Arc<AppState>>,
    Json(replacement): Json<DisplaySelection>,
) -> Result<Json<DisplaySelection>, ApiError> {
    let mut selection = state.current_display_selection.write().await;
    let mut presentation = state.current_display_presentation.write().await;

    selection.selection.quantity = replacement.active_quantity_id;
    selection.selection.view_mode = match replacement.view_mode {
        DisplayViewMode::TwoD => RunnerDisplayViewMode::TwoD,
        DisplayViewMode::ThreeD => RunnerDisplayViewMode::ThreeD,
    };
    selection.selection.field_component = match replacement.field_component {
        FieldComponent::X => DisplayFieldComponent::X,
        FieldComponent::Y => DisplayFieldComponent::Y,
        FieldComponent::Z => DisplayFieldComponent::Z,
        FieldComponent::Magnitude => DisplayFieldComponent::Magnitude,
    };
    selection.selection.auto_scale_enabled = replacement.auto_contrast;
    selection.selection.every_n = replacement.vector_density;
    selection.selection.layer = replacement.slice_layer.max(0) as u32;
    selection.selection.all_layers = replacement.slice_mode == "all";
    selection.selection.max_points = replacement.max_points;
    selection.selection.x_chosen_size = replacement.x_chosen_size;
    selection.selection.y_chosen_size = replacement.y_chosen_size;
    selection.selection.canonicalize();

    presentation.colormap = replacement.colormap;
    presentation.contrast_min = replacement.contrast_min;
    presentation.contrast_max = replacement.contrast_max;
    presentation.vector_glyphs = replacement.vector_glyphs;

    selection.revision = selection.revision.wrapping_add(1);
    Ok(Json(build_display_selection_response(
        &selection,
        &presentation,
    )))
}

#[utoipa::path(
    patch,
    path = "/v1/live/current/display",
    request_body = DisplayPatch,
    responses(
        (status = 200, description = "Display patched", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "display"
)]
pub async fn patch_display(
    State(state): State<Arc<AppState>>,
    Json(update): Json<DisplayPatch>,
) -> Result<Json<DisplaySelection>, ApiError> {
    apply_display_patch(state, update).await
}

async fn apply_display_patch(
    state: Arc<AppState>,
    update: DisplayPatch,
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
