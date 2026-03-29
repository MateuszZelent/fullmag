use crate::types::{LivePreviewField, StepStats};
use serde::{Deserialize, Serialize};

/// The kind of display a quantity produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayKind {
    /// 3D vector field (m, H_ex, H_demag, H_ext, H_eff)
    VectorField,
    /// Spatially-resolved scalar (energy density, component magnitude)
    SpatialScalar,
    /// Single global scalar (E_total, E_ex, E_demag, E_ext)
    GlobalScalar,
}

/// Typed display selection replacing string-based `quantity` field.
///
/// Combines what is currently spread across `LivePreviewRequest` fields
/// into a single, self-describing selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplaySelection {
    pub quantity: String,
    pub kind: DisplayKind,
    pub component: String,
    pub layer: u32,
    pub all_layers: bool,
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
    pub every_n: u32,
    pub max_points: u32,
    pub auto_scale_enabled: bool,
}

impl Default for DisplaySelection {
    fn default() -> Self {
        Self {
            quantity: "m".to_string(),
            kind: DisplayKind::VectorField,
            component: "3D".to_string(),
            layer: 0,
            all_layers: false,
            x_chosen_size: 0,
            y_chosen_size: 0,
            every_n: 10,
            max_points: 16_384,
            auto_scale_enabled: true,
        }
    }
}

impl DisplaySelection {
    /// Classify a quantity string into its display kind.
    pub fn kind_for_quantity(quantity: &str) -> DisplayKind {
        match quantity {
            "E_total" | "E_ex" | "E_demag" | "E_ext" => DisplayKind::GlobalScalar,
            _ => DisplayKind::VectorField,
        }
    }

    /// Convert to a `LivePreviewRequest` for backward compatibility with
    /// the existing preview infrastructure.
    pub fn to_preview_request(&self, revision: u64) -> crate::types::LivePreviewRequest {
        crate::types::LivePreviewRequest {
            revision,
            quantity: self.quantity.clone(),
            component: self.component.clone(),
            layer: self.layer,
            all_layers: self.all_layers,
            every_n: self.every_n,
            x_chosen_size: self.x_chosen_size,
            y_chosen_size: self.y_chosen_size,
            auto_scale_enabled: self.auto_scale_enabled,
            max_points: self.max_points,
        }
    }

    /// Create from an existing `LivePreviewRequest`.
    pub fn from_preview_request(request: &crate::types::LivePreviewRequest) -> Self {
        Self {
            quantity: request.quantity.clone(),
            kind: Self::kind_for_quantity(&request.quantity),
            component: request.component.clone(),
            layer: request.layer,
            all_layers: request.all_layers,
            x_chosen_size: request.x_chosen_size,
            y_chosen_size: request.y_chosen_size,
            every_n: request.every_n,
            max_points: request.max_points,
            auto_scale_enabled: request.auto_scale_enabled,
        }
    }
}

/// Payload returned by display snapshot operations.
///
/// Wraps the specific data kind with metadata for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DisplayPayload {
    VectorField(LivePreviewField),
    SpatialScalar(LivePreviewField),
    GlobalScalar {
        quantity: String,
        value: f64,
        unit: String,
    },
}

impl DisplayPayload {
    /// Create a `DisplayPayload` from a `DisplaySelection` and a `LivePreviewField`.
    pub fn from_vector_field(field: LivePreviewField) -> Self {
        Self::VectorField(field)
    }

    /// Create a global scalar payload from step stats.
    pub fn from_global_scalar(quantity: &str, stats: &StepStats) -> Option<Self> {
        let (value, unit) = match quantity {
            "E_total" => (stats.e_total, "J"),
            "E_ex" => (stats.e_ex, "J"),
            "E_demag" => (stats.e_demag, "J"),
            "E_ext" => (stats.e_ext, "J"),
            _ => return None,
        };
        Some(Self::GlobalScalar {
            quantity: quantity.to_string(),
            value,
            unit: unit.to_string(),
        })
    }
}
