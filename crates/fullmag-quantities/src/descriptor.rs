//! Quantity descriptor — full metadata for one quantity entry.

use crate::id::QuantityId;
use crate::QuantityComponent;
use crate::QuantityShape;
use serde::{Deserialize, Serialize};

/// Where on the mesh a quantity lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityLocation {
    Node,
    Cell,
    Global,
}

impl QuantityLocation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Cell => "cell",
            Self::Global => "global",
        }
    }
}

/// Spatial domain over which a quantity is defined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityDomain {
    MagneticOnly,
    FullDomain,
}

impl QuantityDomain {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MagneticOnly => "magnetic_only",
            Self::FullDomain => "full_domain",
        }
    }
}

/// Hint for display normalization / color mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizationHint {
    UnitVector,
    MaxAbs,
    None,
}

impl NormalizationHint {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnitVector => "unit_vector",
            Self::MaxAbs => "max_abs",
            Self::None => "none",
        }
    }
}

/// Full descriptor for a single quantity in the catalog.
#[derive(Debug, Clone)]
pub struct QuantitySpec {
    pub id: QuantityId,
    pub label: &'static str,
    pub description: &'static str,
    pub shape: QuantityShape,
    pub unit: &'static str,
    pub location: QuantityLocation,
    pub domain: QuantityDomain,
    pub n_comp: u8,
    pub normalization_hint: NormalizationHint,
    pub default_component: QuantityComponent,
    pub interactive_preview: bool,
    pub cached_preview: bool,
    pub supports_preview_2d: bool,
    pub supports_preview_3d: bool,
    pub supports_history: bool,
    pub supports_export: bool,
    pub ui_exposed: bool,
    pub quick_access_label: Option<&'static str>,
    /// If this is a `GlobalScalar`, the key used to look up the scalar value
    /// from the scalar row (e.g. `"e_ex"` for energy terms).
    pub scalar_metric_key: Option<&'static str>,
}
