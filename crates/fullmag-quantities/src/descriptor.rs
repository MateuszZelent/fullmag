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

/// Component semantics for a tensor; shape alone does not identify its axes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuantityTensorDescriptor {
    pub rank: u8,
    pub shape: Vec<u8>,
    pub layout: String,
    pub axes: Vec<String>,
    pub component_labels: Vec<String>,
}

/// Explicit projections of a flow-major tensor; `full` is deliberately absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityTensorProjection {
    C0, C1, C2, C3, C4, C5, C6, C7, C8,
    Frobenius, SpinFlowX, SpinFlowY, SpinFlowZ,
}

impl QuantityTensorProjection {
    pub const ALL: [Self; 13] = [Self::C0, Self::C1, Self::C2, Self::C3, Self::C4,
        Self::C5, Self::C6, Self::C7, Self::C8, Self::Frobenius,
        Self::SpinFlowX, Self::SpinFlowY, Self::SpinFlowZ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::C0 => "c0", Self::C1 => "c1", Self::C2 => "c2",
            Self::C3 => "c3", Self::C4 => "c4", Self::C5 => "c5",
            Self::C6 => "c6", Self::C7 => "c7", Self::C8 => "c8",
            Self::Frobenius => "frobenius", Self::SpinFlowX => "spin_flow_x",
            Self::SpinFlowY => "spin_flow_y", Self::SpinFlowZ => "spin_flow_z",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|projection| projection.as_str() == value)
    }

    pub const fn components(self) -> u8 {
        match self { Self::SpinFlowX | Self::SpinFlowY | Self::SpinFlowZ => 3, _ => 1 }
    }

    pub const fn output_shape(self) -> QuantityShape {
        if self.components() == 3 { QuantityShape::VectorField } else { QuantityShape::SpatialScalar }
    }
}

impl QuantityTensorDescriptor {
    pub fn supports_flow_major_projections(&self) -> bool {
        self.rank == 2 && self.shape == [3, 3] && self.layout == "flow_major"
            && self.axes == ["flow", "spin"] && self.component_labels.len() == 9
            && self.component_labels.iter().all(|label| !label.trim().is_empty())
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

impl QuantitySpec {
    /// Algebraically supported projections; runtime capability is resolved separately.
    pub fn tensor_projections(&self) -> Vec<QuantityTensorProjection> {
        if self.shape == QuantityShape::TensorField && self.n_comp == 9
            && self.tensor_descriptor().is_some_and(|descriptor| descriptor.supports_flow_major_projections()) {
            QuantityTensorProjection::ALL.to_vec()
        } else { Vec::new() }
    }

    /// Legacy accessor — old code used `spec.kind` instead of `spec.shape`.
    pub const fn kind(&self) -> crate::QuantityShape {
        self.shape
    }
}

#[cfg(test)]
mod projection_tests {
    use super::*;

    #[test]
    fn only_explicit_flow_major_projection_tokens_are_legal() {
        let spec = crate::quantity_spec("spin_current_tensor").unwrap();
        let projections = spec.tensor_projections();
        assert_eq!(projections.len(), 13);
        for projection in projections {
            assert_eq!(QuantityTensorProjection::parse(projection.as_str()), Some(projection));
            assert_eq!(serde_json::to_value(projection).unwrap(), projection.as_str());
        }
        for invalid in ["full", "magnitude", "x", "c9", "c00", "spin_flow_a", ""] {
            assert!(QuantityTensorProjection::parse(invalid).is_none());
        }
        assert!(crate::quantity_spec("J_charge").unwrap().tensor_projections().is_empty());
        let mut descriptor = spec.tensor_descriptor().unwrap();
        descriptor.axes.reverse();
        assert!(!descriptor.supports_flow_major_projections());
        descriptor.axes.reverse();
        descriptor.component_labels[0].clear();
        assert!(!descriptor.supports_flow_major_projections());
    }
}
