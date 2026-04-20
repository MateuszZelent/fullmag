use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::schemas::status::{DisplayViewMode, FieldComponent};

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DisplayUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_quantity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_mode: Option<DisplayViewMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_component: Option<FieldComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colormap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_contrast: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contrast_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contrast_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_glyphs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_density: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_layer: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_points: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_chosen_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_chosen_size: Option<u32>,
}
