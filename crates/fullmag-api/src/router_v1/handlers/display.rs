//! PUT /v1/live/current/display — update display selection.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::display::DisplayUpdate;
use crate::schemas::status::DisplaySelection;
use crate::types::AppState;

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
    let mut sel = state.current_display_selection.write().await;

    if let Some(q) = update.active_quantity_id {
        sel.selection.quantity = q;
    }
    if let Some(c) = update.component {
        sel.selection.component = c;
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

    sel.revision = sel.revision.wrapping_add(1);
    let response = DisplaySelection {
        active_quantity_id: sel.selection.quantity.clone(),
        component: sel.selection.component.clone(),
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
    };

    Ok(Json(response))
}
