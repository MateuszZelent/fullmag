//! Quantity-centric output types for the IR layer (QB-11).
//!
//! `QuantityOutputIR` is the new, canonical way to express "save this quantity"
//! in the intermediate representation.  The legacy `OutputIR::Field` and
//! `OutputIR::Scalar` variants remain for backward compatibility but will be
//! lowered to `QuantityOutputIR` by the planner.

use fullmag_quantities::{QuantityId, QuantityReduction};
use serde::{Deserialize, Serialize};

/// The sink (destination) for a quantity output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputSinkIR {
    /// Stream to the live WebSocket preview.
    LivePreview,
    /// Write a snapshot artifact to disk.
    SnapshotArtifact,
    /// Append a row to the scalar table.
    TableRow,
    /// Make available for Python runtime pull.
    PythonPull,
    /// Stream via the API.
    ApiStream,
}

/// A quantity-centric output request in the IR.
///
/// This separates _what_ to save (`quantity_id`) from _where_ to send it
/// (`sink`), with optional reduction and component selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantityOutputIR {
    /// Which quantity to output.
    pub quantity_id: QuantityId,
    /// Where to send the output.
    pub sink: OutputSinkIR,
    /// Optional component selection (e.g., "x", "z", "magnitude").
    /// `None` means all components.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    /// Optional reduction (e.g., average, max).
    /// `None` means raw spatial data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reduction: Option<QuantityReduction>,
    /// Cadence: save every N seconds of simulation time.
    /// `None` means every step for table rows, or on-demand for snapshots.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_seconds: Option<f64>,
}

/// Convert a legacy `OutputIR::Field` to the new `QuantityOutputIR`.
///
/// Returns `None` if the field name cannot be resolved to a known `QuantityId`.
pub fn field_to_quantity_output(
    field_name: &str,
    every_seconds: f64,
) -> Option<QuantityOutputIR> {
    let quantity_id = fullmag_quantities::normalize_quantity_id(field_name).ok()?;
    Some(QuantityOutputIR {
        quantity_id,
        sink: OutputSinkIR::SnapshotArtifact,
        component: None,
        reduction: None,
        every_seconds: Some(every_seconds),
    })
}

/// Convert a legacy `OutputIR::Scalar` to the new `QuantityOutputIR`.
///
/// Returns `None` if the scalar name cannot be resolved.
pub fn scalar_to_quantity_output(
    scalar_name: &str,
    every_seconds: f64,
) -> Option<QuantityOutputIR> {
    let quantity_id = fullmag_quantities::normalize_quantity_id(scalar_name).ok()?;
    Some(QuantityOutputIR {
        quantity_id,
        sink: OutputSinkIR::TableRow,
        component: None,
        reduction: None,
        every_seconds: Some(every_seconds),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_to_quantity_converts_known_name() {
        let out = field_to_quantity_output("m", 1e-12).unwrap();
        assert_eq!(out.quantity_id, QuantityId::M);
        assert_eq!(out.sink, OutputSinkIR::SnapshotArtifact);
    }

    #[test]
    fn field_to_quantity_rejects_unknown() {
        assert!(field_to_quantity_output("not_a_real_quantity", 1e-12).is_none());
    }

    #[test]
    fn scalar_to_quantity_converts_energy() {
        let out = scalar_to_quantity_output("E_total", 1e-12).unwrap();
        assert_eq!(out.quantity_id, QuantityId::ETotal);
        assert_eq!(out.sink, OutputSinkIR::TableRow);
    }
}
