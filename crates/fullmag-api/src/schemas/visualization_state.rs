use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct VisualizationStateResource {
    /// Monotonic revision of all visualization state.
    pub revision: u64,
    /// Schema semver for consumers to detect payload shape changes.
    pub schema_version: u32,
    pub active_quantity_id: String,
    pub view_mode: crate::schemas::status::DisplayViewMode,
    pub field_component: crate::schemas::status::FieldComponent,
    pub colormap: String,
    pub auto_contrast: bool,
    pub contrast_min: Option<f64>,
    pub contrast_max: Option<f64>,
    pub vector_glyphs: bool,
    pub vector_density: u32,
    pub slice_mode: String,
    pub slice_layer: i32,
    pub max_points: u32,
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct VisualizationStatePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_quantity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_mode: Option<crate::schemas::status::DisplayViewMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_component: Option<crate::schemas::status::FieldComponent>,
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
