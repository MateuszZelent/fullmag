//! Wire format of a prepared-state observation bundle (ADR 0071 v1).
//!
//! The FEM preparer writes it under its preparation lease; the live API adopts
//! it together with the prepared magnetization. Field values are immutable
//! F64LE CAS chunks in the accepted binary-field layout, so the API reads them
//! through the same verified reader as accepted run fields.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const PREPARED_OBSERVATION_BUNDLE_SCHEMA: &str =
    "fullmag.prepared_observation_bundle.v1";
/// Shared with `accepted_field_binary::ACCEPTED_FIELD_BINARY_SCHEMA`; the
/// writer-only items below are used by the preparer binary.
#[allow(dead_code)]
pub(crate) const PREPARED_FIELD_BINARY_SCHEMA: &str = "fullmag.accepted_field.f64le.v1";
#[allow(dead_code)]
pub(crate) const PREPARED_FIELD_CHUNK_VALUES: usize = 65_536;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreparedObservationBundle {
    pub(crate) schema_version: String,
    pub(crate) identity: fullmag_runner::PreparedStateIdentity,
    pub(crate) clock: fullmag_quantities::ObservationClock,
    pub(crate) evaluation_lane: String,
    pub(crate) requested_lane: String,
    pub(crate) evaluator_build_identity: Value,
    pub(crate) fields: Vec<PreparedObservationField>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) unavailable_scopes: BTreeMap<String, String>,
    /// Canonical global energy IDs mapped to evaluated joule values.
    pub(crate) energies: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreparedObservationField {
    pub(crate) quantity_id: String,
    pub(crate) carrier_id: String,
    pub(crate) role: String,
    pub(crate) n_comp: usize,
    pub(crate) layout: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) spatial_kind: Option<String>,
    /// Accepted binary-field reference (`fullmag.accepted_field.f64le.v1`).
    pub(crate) binary: Value,
}

/// Layout of the live API's published prepared FEM magnetization.
#[allow(dead_code)]
pub(crate) fn prepared_fem_magnetization_layout(node_count: usize) -> Value {
    json!({"backend": "fem", "location": "node", "node_count": node_count})
}

/// Canonical evaluation/requested lane label for a FEM device.
#[allow(dead_code)]
pub(crate) fn fem_lane_label(device: &str) -> Option<&'static str> {
    match device {
        "cpu" => Some("fem_cpu"),
        "gpu" => Some("fem_gpu"),
        _ => None,
    }
}
