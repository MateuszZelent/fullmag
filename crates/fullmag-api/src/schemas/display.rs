use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DisplayUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_quantity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
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
}
