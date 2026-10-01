//! Native representation receipt bound to one exported local-node m snapshot.
//! This is producer evidence, not a scientific or native index-map certificate.

use crate::{is_canonical_sha256, FemRepresentationReceipt, FemStateRepresentation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FEM_LOCAL_NODE_SNAPSHOT_RECEIPT_SCHEMA: &str =
    "fullmag.fem_local_node_snapshot_receipt.v1";
pub const FEM_FINAL_SNAPSHOT_RECEIPT_ARTIFACT: &str =
    "representation/fem_final_m_snapshot_receipt.v1.json";
pub const MAX_FEM_SNAPSHOT_RECEIPT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemLocalNodeSnapshotReceipt {
    pub schema_version: String,
    pub snapshot_step: u64,
    pub snapshot_time_s: f64,
    pub snapshot_solver_dt_s: f64,
    /// SHA-256 of finite local-node/component F64 little-endian values.
    /// This is also the byte ordering used by the derived durable tensor.
    pub values_sha256: String,
    pub representation: FemRepresentationReceipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_node_map_sha256: Option<String>,
    /// Node/cell projection observed from the same exclusively owned handle.
    /// Does not include markers/facets or certify runtime/scientific validity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_indexed_geometry_sha256: Option<String>,
}

impl FemLocalNodeSnapshotReceipt {
    pub fn validate_node_map(
        &self,
        map: Option<&crate::fem_local_node_map::FemLocalNodeIndexMap>,
    ) -> Result<(), String> {
        match (&self.native_node_map_sha256, map) {
            (None, None) => Ok(()),
            (Some(expected), Some(map)) => {
                map.validate_representation(&self.representation)?;
                if &map.content_sha256()? != expected {
                    return Err("native FEM node map digest differs from snapshot receipt".into());
                }
                Ok(())
            }
            _ => Err("native FEM snapshot receipt and node map must be present together".into()),
        }
    }

    pub fn capture(
        step: u64,
        time_s: f64,
        solver_dt_s: f64,
        values: &[[f64; 3]],
        representation: FemRepresentationReceipt,
    ) -> Result<Self, String> {
        let receipt = Self {
            schema_version: FEM_LOCAL_NODE_SNAPSHOT_RECEIPT_SCHEMA.into(),
            snapshot_step: step,
            snapshot_time_s: time_s,
            snapshot_solver_dt_s: solver_dt_s,
            values_sha256: local_node_values_sha256(values)?,
            representation,
            native_node_map_sha256: None,
            native_indexed_geometry_sha256: None,
        };
        receipt.validate(values.len())?;
        Ok(receipt)
    }

    pub fn validate(&self, node_count: usize) -> Result<(), String> {
        let representation = &self.representation;
        if self.schema_version != FEM_LOCAL_NODE_SNAPSHOT_RECEIPT_SCHEMA
            || !is_canonical_sha256(&self.values_sha256)
            || self
                .native_node_map_sha256
                .as_ref()
                .is_some_and(|hash| !is_canonical_sha256(hash))
            || self
                .native_indexed_geometry_sha256
                .as_ref()
                .is_some_and(|hash| {
                    !is_canonical_sha256(hash) || self.native_node_map_sha256.is_none()
                })
            || !self.snapshot_time_s.is_finite()
            || self.snapshot_time_s < 0.0
            || !self.snapshot_solver_dt_s.is_finite()
            || self.snapshot_solver_dt_s < 0.0
            || node_count == 0
            || representation.schema_version != 1
            || representation.state_space != FemStateRepresentation::LocalNodeAos
            || representation.local_node_count != node_count as u64
            || representation.true_node_count == 0
            || representation.true_node_count > representation.local_node_count
            || (representation.true_node_count < representation.local_node_count
                && representation.periodic_map_revision == 0)
            || representation.invalid_space_assertion_count != 0
            || representation.hot_loop_representation_copy_count
                > representation.representation_copy_count
            || representation.hot_loop_gather_scatter_bytes > representation.gather_scatter_bytes
        {
            return Err("invalid native FEM local-node snapshot receipt".into());
        }
        Ok(())
    }

    pub fn validate_snapshot(
        &self,
        step: u64,
        time_s: f64,
        solver_dt_s: f64,
        values: &[[f64; 3]],
    ) -> Result<(), String> {
        self.validate(values.len())?;
        if self.snapshot_step != step
            || self.snapshot_time_s.to_bits() != time_s.to_bits()
            || self.snapshot_solver_dt_s.to_bits() != solver_dt_s.to_bits()
            || self.values_sha256 != local_node_values_sha256(values)?
        {
            return Err("native FEM receipt differs from the exact m snapshot".into());
        }
        Ok(())
    }
}

/// Hash without allocating a second full field buffer.
pub fn local_node_values_sha256(values: &[[f64; 3]]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for value in values.iter().flatten() {
        if !value.is_finite() {
            return Err("native FEM snapshot contains nonfinite values".into());
        }
        hasher.update(value.to_le_bytes());
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

pub fn parse_fem_snapshot_receipt(bytes: &[u8]) -> Result<FemLocalNodeSnapshotReceipt, String> {
    if bytes.is_empty() || bytes.len() > MAX_FEM_SNAPSHOT_RECEIPT_BYTES {
        return Err("FEM snapshot receipt exceeds its metadata byte budget".into());
    }
    let wire: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    parse_fem_snapshot_receipt_value(&wire)
}

pub fn parse_fem_snapshot_receipt_value(
    wire: &serde_json::Value,
) -> Result<FemLocalNodeSnapshotReceipt, String> {
    // Bound a nested layout value before cloning it. A malicious JSON field
    // must not cause another full state-sized allocation during receipt parse.
    struct MetadataBudget(usize);
    impl std::io::Write for MetadataBudget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_FEM_SNAPSHOT_RECEIPT_BYTES.saturating_sub(self.0) {
                return Err(std::io::Error::other(
                    "FEM snapshot receipt exceeds metadata budget",
                ));
            }
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(MetadataBudget(0), wire).map_err(|e| e.to_string())?;
    let receipt: FemLocalNodeSnapshotReceipt =
        serde_json::from_value(wire.clone()).map_err(|e| e.to_string())?;
    // The shared step receipt accepts legacy telemetry extensions; this
    // immutable snapshot boundary must not silently drop nested fields.
    if serde_json::to_value(&receipt).map_err(|e| e.to_string())? != *wire {
        return Err("FEM snapshot receipt contains unrecognized representation fields".into());
    }
    Ok(receipt)
}

#[cfg(test)]
#[path = "fem_state_snapshot_receipt_tests.rs"]
mod tests;
