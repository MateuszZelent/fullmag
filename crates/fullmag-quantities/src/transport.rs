//! Live transport wire types for the quantity system.
//!
//! These types define the canonical contract between the runner/backend
//! and the API/frontend for streaming quantity data during simulation.

use crate::step_data::{GlobalQuantityRow, StepDataKind, StepDiagnostics};
use serde::{Deserialize, Serialize};

/// Provenance retained when a materialized preview field is promoted to the
/// canonical live-quantity transport.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveQuantityFrameProvenance {
    pub config_revision: u64,
    pub source_step: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_time_seconds: Option<f64>,
    pub source_revision: u64,
    pub materialized_at_unix_ms: u64,
    pub materialization_wall_time_ns: u64,
}

/// The spatial layout used to produce a live quantity frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveQuantityFrameLayout {
    pub original_grid: [u32; 3],
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
    pub applied_x_chosen_size: u32,
    pub applied_y_chosen_size: u32,
    pub applied_layer_stride: u32,
    pub auto_downscaled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_downscale_message: Option<String>,
}

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
    /// Source and materialization provenance for a promoted preview field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<LiveQuantityFrameProvenance>,
    /// Spatial kind projected from the producer's field descriptor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial_kind: Option<String>,
    /// Physical domain projected from the producer's field descriptor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantity_domain: Option<String>,
    /// Source and sampled-grid layout for this frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<LiveQuantityFrameLayout>,
}

/// V2 step update — cleanly separates diagnostics, scalar row, and spatial frames.
///
/// This is the target wire format; the existing `StepUpdate` remains
/// as a backward-compatible shim during migration.
#[derive(Debug, Clone)]
pub struct StepUpdateV2 {
    /// Solver telemetry for this step.
    pub diagnostics: StepDiagnostics,
    /// Scalar compatibility row, qualified only when its kind is physical.
    pub scalars: GlobalQuantityRow,
    /// Zero or more spatial quantity frames (e.g., magnetization preview).
    pub frames: Vec<LiveQuantityFrame>,
    /// True when the simulation has completed.
    pub finished: bool,
}

impl StepUpdateV2 {
    /// Validate that the step record has one coherent semantic kind and payload.
    pub fn validate(&self) -> Result<(), &'static str> {
        self.diagnostics.validate_record_kind()?;
        if self.diagnostics.kind != self.scalars.kind {
            return Err("step diagnostics and scalar row kinds must match");
        }
        match self.diagnostics.kind {
            StepDataKind::PhysicalObservation => {}
            StepDataKind::SolverProgress => {
                if !self.scalars.per_object_scalars.is_empty() {
                    return Err("solver progress records cannot carry per-object scalar samples");
                }
            }
            StepDataKind::LegacyUnclassified => {
                if !self.frames.is_empty() {
                    return Err(
                        "legacy unclassified records cannot carry physical quantity frames",
                    );
                }
            }
        }
        if !self.diagnostics.kind.is_physical_observation() && !self.frames.is_empty() {
            return Err("only physical observations can carry quantity frames");
        }
        Ok(())
    }
}

impl Serialize for StepUpdateV2 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        self.validate().map_err(serde::ser::Error::custom)?;
        let field_count = if self.frames.is_empty() { 3 } else { 4 };
        let mut state = serializer.serialize_struct("StepUpdateV2", field_count)?;
        state.serialize_field("diagnostics", &self.diagnostics)?;
        state.serialize_field("scalars", &self.scalars)?;
        if !self.frames.is_empty() {
            state.serialize_field("frames", &self.frames)?;
        }
        state.serialize_field("finished", &self.finished)?;
        state.end()
    }
}

#[derive(Deserialize)]
struct StepUpdateV2Repr {
    diagnostics: StepDiagnostics,
    scalars: GlobalQuantityRow,
    #[serde(default)]
    frames: Vec<LiveQuantityFrame>,
    #[serde(default)]
    finished: bool,
}

impl<'de> Deserialize<'de> for StepUpdateV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;

        let repr = StepUpdateV2Repr::deserialize(deserializer)?;
        let update = Self {
            diagnostics: repr.diagnostics,
            scalars: repr.scalars,
            frames: repr.frames,
            finished: repr.finished,
        };
        update.validate().map_err(D::Error::custom)?;
        Ok(update)
    }
}

#[cfg(test)]
mod step_update_v2_validation_tests {
    use super::{LiveQuantityFrame, StepUpdateV2};
    use crate::{GlobalQuantityRow, SolverProgress, StepDataKind, StepDiagnostics};
    use std::collections::HashMap;

    fn progress_update() -> StepUpdateV2 {
        StepUpdateV2 {
            diagnostics: StepDiagnostics {
                kind: StepDataKind::SolverProgress,
                solver_progress: Some(SolverProgress::FemEigen {
                    metrics: HashMap::from([("percent".into(), 50.0)]),
                }),
                ..StepDiagnostics::default()
            },
            scalars: GlobalQuantityRow {
                kind: StepDataKind::SolverProgress,
                ..GlobalQuantityRow::default()
            },
            frames: Vec::new(),
            finished: false,
        }
    }

    fn progress_update_json() -> serde_json::Value {
        serde_json::to_value(progress_update()).expect("valid progress update serializes")
    }

    #[test]
    fn typed_progress_round_trips_without_a_fake_object_namespace() {
        let update = progress_update();
        assert!(update.validate().is_ok());
        let value = serde_json::to_value(&update).expect("progress update serializes");
        assert_eq!(value["diagnostics"]["solver_progress"]["kind"], "fem_eigen");
        assert_eq!(
            value["diagnostics"]["solver_progress"]["metrics"]["percent"],
            50.0
        );
        assert!(value["scalars"].get("per_object_scalars").is_none());

        let restored: StepUpdateV2 =
            serde_json::from_value(value).expect("progress update parses");
        assert_eq!(restored.diagnostics.kind, StepDataKind::SolverProgress);
        assert_eq!(restored.scalars.kind, StepDataKind::SolverProgress);
        assert!(restored.validate().is_ok());
    }

    #[test]
    fn serialization_and_deserialization_reject_contradictory_kinds_and_payloads() {
        let mut invalid = progress_update();
        invalid.diagnostics.solver_progress = None;
        assert!(invalid.validate().is_err());
        assert!(serde_json::to_value(&invalid).is_err());

        let mut value = serde_json::to_value(progress_update()).expect("valid update serializes");
        value["scalars"]["kind"] = serde_json::json!("physical_observation");
        assert!(serde_json::from_value::<StepUpdateV2>(value).is_err());
    }

    #[test]
    fn deserialization_rejects_null_and_contradictory_progress_payloads() {
        let mut null_payload = progress_update_json();
        null_payload["diagnostics"]["solver_progress"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<StepUpdateV2>(null_payload).is_err());

        let mut physical_with_progress = progress_update_json();
        physical_with_progress["diagnostics"]["kind"] =
            serde_json::json!("physical_observation");
        physical_with_progress["scalars"]["kind"] = serde_json::json!("physical_observation");
        assert!(serde_json::from_value::<StepUpdateV2>(physical_with_progress).is_err());
    }

    #[test]
    fn deserialization_rejects_progress_object_samples_and_physical_frames() {
        let mut per_object_samples = progress_update_json();
        per_object_samples["scalars"]["per_object_scalars"] = serde_json::json!({
            "magnet": {"mx": 0.5}
        });
        assert!(serde_json::from_value::<StepUpdateV2>(per_object_samples).is_err());

        let mut physical_frames = progress_update_json();
        physical_frames["frames"] = serde_json::json!([{
            "quantity_id": "m",
            "unit": "1",
            "grid": [1, 1, 1],
            "n_comp": 3,
            "values": [0.0, 0.0, 0.0]
        }]);
        assert!(serde_json::from_value::<StepUpdateV2>(physical_frames).is_err());
    }

    #[test]
    fn missing_legacy_kinds_preserve_raw_scalars_without_quantity_admission() {
        let update = StepUpdateV2 {
            diagnostics: StepDiagnostics::default(),
            scalars: GlobalQuantityRow {
                e_total: 3.5,
                ..GlobalQuantityRow::default()
            },
            frames: Vec::new(),
            finished: false,
        };
        let mut value = serde_json::to_value(update).expect("physical update serializes");
        value["diagnostics"]
            .as_object_mut()
            .expect("diagnostics object")
            .remove("kind");
        value["scalars"]
            .as_object_mut()
            .expect("scalar object")
            .remove("kind");

        let restored: StepUpdateV2 =
            serde_json::from_value(value).expect("legacy update parses");
        assert_eq!(restored.diagnostics.kind, StepDataKind::LegacyUnclassified);
        assert_eq!(restored.scalars.kind, StepDataKind::LegacyUnclassified);
        assert_eq!(restored.scalars.e_total, 3.5);
        assert_eq!(restored.scalars.scalar_value("e_total"), None);
    }

    #[test]
    fn progress_updates_reject_physical_frames() {
        let mut update = progress_update();
        update.frames.push(LiveQuantityFrame {
            quantity_id: "m".into(),
            unit: "1".into(),
            grid: [1, 1, 1],
            n_comp: 3,
            values: vec![0.0; 3],
            active_mask: None,
            provenance: None,
            spatial_kind: None,
            quantity_domain: None,
            layout: None,
        });
        assert!(update.validate().is_err());
        assert!(serde_json::to_value(update).is_err());
    }
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
    pub ui_exposed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_access_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scalar_metric_key: Option<String>,
}

/// Build the full wire catalog from the static spec table.
pub fn build_wire_catalog() -> Vec<QuantityDescriptorWire> {
    crate::quantity_catalog()
        .iter()
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
            ui_exposed: spec.ui_exposed,
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
