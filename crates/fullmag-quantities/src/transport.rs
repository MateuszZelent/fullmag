//! Live transport wire types for the quantity system.
//!
//! These types define the canonical contract between the runner/backend
//! and the API/frontend for streaming quantity data during simulation.

use crate::step_data::{GlobalQuantityRow, StepDiagnostics};
use serde::{Deserialize, Serialize};

/// A single live quantity frame attached to a step update.
///
/// Replaces the old `LivePreviewField` approach with a generic,
/// quantity-ID-driven wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveQuantityFrame {
    /// Which quantity this frame carries.
    pub quantity_id: String,
    /// Unit of the quantity values.
    pub unit: String,
    /// Grid dimensions [nx, ny, nz] for spatial quantities.
    pub grid: [u32; 3],
    /// Number of components per point (3 for vectors, 1 for scalars).
    pub n_comp: u8,
    /// Flat array of values: length = nx*ny*nz * n_comp.
    pub values: Vec<f64>,
    /// Per-cell boolean mask (same spatial dims as grid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_mask: Option<Vec<bool>>,
}

/// V2 step update — cleanly separates diagnostics, scalar row, and spatial frames.
///
/// This is the target wire format; the existing `StepUpdate` remains
/// as a backward-compatible shim during migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepUpdateV2 {
    /// Solver telemetry for this step.
    pub diagnostics: StepDiagnostics,
    /// Physical scalar observations (energies, averages).
    pub scalars: GlobalQuantityRow,
    /// Zero or more spatial quantity frames (e.g., magnetization preview).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<LiveQuantityFrame>,
    /// True when the simulation has completed.
    #[serde(default)]
    pub finished: bool,
}

/// A request from the frontend for a specific live quantity preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantityPreviewRequest {
    /// The quantity to preview.
    pub quantity_id: String,
    /// Component selection: "3D", "x", "y", "z", "magnitude".
    #[serde(default = "default_component")]
    pub component: String,
    /// Layer index (0 = bottom).
    #[serde(default)]
    pub layer: u32,
    /// If true, send all layers.
    #[serde(default)]
    pub all_layers: bool,
    /// Send every N-th step.
    #[serde(default = "default_every_n")]
    pub every_n: u32,
}

fn default_component() -> String {
    "3D".to_string()
}

const fn default_every_n() -> u32 {
    10
}

/// API-facing quantity descriptor (wire format for `GET /api/quantities/catalog`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantityDescriptorWire {
    pub id: String,
    pub label: String,
    pub description: String,
    pub shape: String,
    pub unit: String,
    pub location: String,
    pub domain: String,
    pub n_comp: u8,
    pub normalization_hint: String,
    pub interactive_preview: bool,
    pub supports_preview_2d: bool,
    pub supports_preview_3d: bool,
    pub supports_history: bool,
    pub supports_export: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_access_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scalar_metric_key: Option<String>,
}

/// Build the full wire catalog from the static spec table.
pub fn build_wire_catalog() -> Vec<QuantityDescriptorWire> {
    crate::quantity_catalog()
        .iter()
        .filter(|spec| spec.ui_exposed)
        .map(|spec| QuantityDescriptorWire {
            id: spec.id.as_str().to_string(),
            label: spec.label.to_string(),
            description: spec.description.to_string(),
            shape: spec.shape.as_str().to_string(),
            unit: spec.unit.to_string(),
            location: spec.location.as_str().to_string(),
            domain: spec.domain.as_str().to_string(),
            n_comp: spec.n_comp,
            normalization_hint: spec.normalization_hint.as_str().to_string(),
            interactive_preview: spec.interactive_preview,
            supports_preview_2d: spec.supports_preview_2d,
            supports_preview_3d: spec.supports_preview_3d,
            supports_history: spec.supports_history,
            supports_export: spec.supports_export,
            quick_access_label: spec.quick_access_label.map(str::to_string),
            scalar_metric_key: spec.scalar_metric_key.map(str::to_string),
        })
        .collect()
}

/// Catalog response envelope for the API endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantityCatalogResponse {
    pub schema_version: String,
    pub quantities: Vec<QuantityDescriptorWire>,
}

impl QuantityCatalogResponse {
    pub fn build() -> Self {
        Self {
            schema_version: crate::SCHEMA_VERSION.to_string(),
            quantities: build_wire_catalog(),
        }
    }
}

/// Extended wire descriptor with runtime availability — used by the API
/// to inject session-specific state into the canonical wire descriptor.
///
/// This replaces the ad-hoc `QuantityDescriptor` that lived in the API crate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantityDescriptorLive {
    /// All static metadata from the catalog.
    #[serde(flatten)]
    pub wire: QuantityDescriptorWire,
    /// Whether the quantity currently has data available in this session.
    pub available: bool,
    /// Whether interactive (live) preview is available for this quantity.
    pub interactive_preview_available: bool,
}

impl QuantityDescriptorLive {
    /// Build from a wire descriptor and runtime availability flags.
    pub fn from_wire(
        wire: QuantityDescriptorWire,
        available: bool,
        interactive_preview_available: bool,
    ) -> Self {
        Self {
            wire,
            available,
            interactive_preview_available,
        }
    }
}
