use crate::quantities::{global_scalar_value, quantity_spec, QuantityKind};
use crate::types::{LivePreviewField, StepStats};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisplayViewMode {
    #[serde(rename = "2d")]
    TwoD,
    #[serde(rename = "3d")]
    ThreeD,
}

impl DisplayViewMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TwoD => "2d",
            Self::ThreeD => "3d",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayFieldComponent {
    X,
    Y,
    Z,
    Magnitude,
}

impl DisplayFieldComponent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::X => "x",
            Self::Y => "y",
            Self::Z => "z",
            Self::Magnitude => "magnitude",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "x" => Some(Self::X),
            "y" => Some(Self::Y),
            "z" => Some(Self::Z),
            "magnitude" => Some(Self::Magnitude),
            _ => None,
        }
    }
}

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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisplaySelection {
    pub quantity: String,
    pub kind: DisplayKind,
    pub view_mode: DisplayViewMode,
    pub field_component: DisplayFieldComponent,
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
            view_mode: DisplayViewMode::ThreeD,
            field_component: DisplayFieldComponent::Magnitude,
            layer: 0,
            all_layers: false,
            x_chosen_size: 0,
            y_chosen_size: 0,
            every_n: 50,
            max_points: 16_384,
            auto_scale_enabled: true,
        }
    }
}

/// Monotonic display selection state used by interactive control-plane.
///
/// Keeps the selected display together with a revision counter so refreshes can
/// be distinguished from unchanged selections.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisplaySelectionState {
    pub revision: u64,
    pub selection: DisplaySelection,
}

impl Default for DisplaySelectionState {
    fn default() -> Self {
        Self {
            revision: 0,
            selection: DisplaySelection::default(),
        }
    }
}

impl DisplaySelectionState {
    /// Convert to a backward-compatible preview request.
    pub fn preview_request(&self) -> crate::types::LivePreviewRequest {
        self.selection.to_preview_request(self.revision)
    }

    /// Create state from an existing preview request.
    pub fn from_preview_request(request: &crate::types::LivePreviewRequest) -> Self {
        Self {
            revision: request.revision,
            selection: DisplaySelection::from_preview_request(request),
        }
    }
}

impl DisplaySelection {
    /// Classify a quantity string into its display kind.
    pub fn kind_for_quantity(quantity: &str) -> DisplayKind {
        match quantity_spec(quantity).map(|spec| spec.shape) {
            Some(QuantityKind::GlobalScalar) => DisplayKind::GlobalScalar,
            Some(QuantityKind::SpatialScalar) => DisplayKind::SpatialScalar,
            Some(QuantityKind::VectorField) | None => DisplayKind::VectorField,
        }
    }

    /// Convert to a `LivePreviewRequest` for backward compatibility with
    /// the existing preview infrastructure.
    pub fn to_preview_request(&self, revision: u64) -> crate::types::LivePreviewRequest {
        crate::types::LivePreviewRequest {
            revision,
            quantity: self.quantity.clone(),
            component: self.preview_component().to_string(),
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
        let mut selection = Self {
            quantity: request.quantity.clone(),
            kind: Self::kind_for_quantity(&request.quantity),
            view_mode: if request.component == "3D" {
                DisplayViewMode::ThreeD
            } else {
                DisplayViewMode::TwoD
            },
            field_component: DisplayFieldComponent::parse(&request.component)
                .unwrap_or(DisplayFieldComponent::Magnitude),
            layer: request.layer,
            all_layers: request.all_layers,
            x_chosen_size: request.x_chosen_size,
            y_chosen_size: request.y_chosen_size,
            every_n: request.every_n,
            max_points: request.max_points,
            auto_scale_enabled: request.auto_scale_enabled,
        };
        selection.canonicalize();
        selection
    }

    pub fn preview_component(&self) -> &'static str {
        if matches!(self.kind, DisplayKind::VectorField)
            && matches!(self.view_mode, DisplayViewMode::ThreeD)
        {
            "3D"
        } else {
            self.field_component.as_str()
        }
    }

    pub fn canonicalize(&mut self) {
        self.kind = Self::kind_for_quantity(&self.quantity);
        match self.kind {
            DisplayKind::VectorField => {}
            DisplayKind::SpatialScalar | DisplayKind::GlobalScalar => {
                self.view_mode = DisplayViewMode::TwoD;
                self.field_component = DisplayFieldComponent::Magnitude;
            }
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
    /// Create a `DisplayPayload` from a live preview field and its display kind.
    pub fn from_live_preview_field(kind: DisplayKind, field: LivePreviewField) -> Self {
        match kind {
            DisplayKind::VectorField => Self::VectorField(field),
            DisplayKind::SpatialScalar => Self::SpatialScalar(field),
            DisplayKind::GlobalScalar => {
                unreachable!("global scalar displays do not carry LivePreviewField payloads")
            }
        }
    }

    /// Create a global scalar payload from step stats.
    pub fn from_global_scalar(quantity: &str, stats: &StepStats) -> Option<Self> {
        let spec = quantity_spec(quantity)?;
        let value = global_scalar_value(quantity, stats)?;
        Some(Self::GlobalScalar {
            quantity: quantity.to_string(),
            value,
            unit: spec.unit.to_string(),
        })
    }
}
