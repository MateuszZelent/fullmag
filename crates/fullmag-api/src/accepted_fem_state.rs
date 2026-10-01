//! Accepted FEM CPU state identity.
//!
//! This module is deliberately separate from the FDM observation snapshots.
//! It consumes the application field codec and the native receipt emitted by
//! the runner; it never reconstructs native identity from a plan or a trace.

use fullmag_application::MagnetizationStateArtifact;
use fullmag_quantities::{
    accepted_state_digests, AcceptedPrimaryCarrier, AcceptedStateGeneration, AcceptedStateId,
    AcceptedStateRef, ObservationClock,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FEM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA: &str =
    "fullmag.fem.cpu.accepted-state-snapshot.v1";
pub const FEM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE: &str =
    "solver/fem_cpu_accepted_state_snapshot.v1.json";

pub const FEM_CPU_NATIVE_LOCAL_NODE_VALUES_CARRIER: &str =
    "fem.cpu.native-local-node-values-f64le.v1";
pub const FEM_CPU_NATIVE_LOCAL_NODE_MAP_CARRIER: &str = "fem.cpu.native-local-node-map.v1";
pub const FEM_CPU_NATIVE_INDEXED_GEOMETRY_CARRIER: &str = "fem.cpu.native-indexed-geometry.v1";

const FEM_CPU_PRIMARY_CARRIERS: [&str; 3] = [
    FEM_CPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
    FEM_CPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
    FEM_CPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
];

/// Accepted-state identity for one completed native FEM CPU endpoint.
///
/// The three payload fields are digests of producer-owned bytes. Keeping the
/// bytes out of this envelope prevents a second state-sized allocation in the
/// durable control plane; the field output remains the typed study artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FemCpuAcceptedStateSnapshotV1 {
    pub schema_version: String,
    pub clock: ObservationClock,
    pub values_sha256: String,
    pub native_node_map_sha256: String,
    pub native_indexed_geometry_sha256: String,
    pub clock_digest: String,
    pub state_digest: String,
    pub primary_carrier_ids: Vec<String>,
}

impl FemCpuAcceptedStateSnapshotV1 {
    /// Build the accepted state only from an application-decoded native FEM
    /// field. All producer-owned receipts and map digests are mandatory.
    pub(crate) fn from_magnetization_state(
        state: &MagnetizationStateArtifact,
    ) -> Result<Self, String> {
        if state.layout.get("backend").and_then(Value::as_str) != Some("fem")
            || state.layout.get("fe_order").and_then(Value::as_u64) != Some(1)
            || state
                .layout
                .get("n_nodes")
                .and_then(Value::as_u64)
                .and_then(|count| usize::try_from(count).ok())
                != Some(state.values.len())
        {
            return Err("accepted FEM CPU state requires H1/P1 nodal layout".into());
        }
        if fullmag_application::decode_magnetization_field_semantics(state)
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err(
                "accepted FEM CPU state requires explicit H1/P1 field_semantics metadata".into(),
            );
        }
        if state
            .provenance
            .get("execution_engine")
            .and_then(Value::as_str)
            != Some("fem_cpu_native")
            || state
                .provenance
                .get("resolved_execution_engine")
                .and_then(Value::as_str)
                .is_some_and(|engine| engine != "fem_cpu_native")
            || state
                .provenance
                .get("resolved_fallback")
                .is_some_and(|fallback| !fallback.is_null())
            || state
                .provenance
                .get("lossy_fallback_used")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err("accepted FEM CPU state has non-native or fallback provenance".into());
        }

        let receipt = state
            .native_state_snapshot
            .as_ref()
            .ok_or_else(|| "accepted FEM CPU state has no native snapshot receipt".to_string())?;
        let map = state
            .native_node_map
            .as_ref()
            .ok_or_else(|| "accepted FEM CPU state has no native node map".to_string())?;
        receipt.validate_snapshot(state.step, state.time_s, state.solver_dt_s, &state.values)?;
        receipt.validate_node_map(Some(map))?;
        let native_node_map_sha256 = receipt
            .native_node_map_sha256
            .as_deref()
            .ok_or_else(|| "native snapshot receipt has no node-map digest".to_string())?;
        let native_indexed_geometry_sha256 = receipt
            .native_indexed_geometry_sha256
            .as_deref()
            .ok_or_else(|| "native snapshot receipt has no indexed-geometry digest".to_string())?;
        if state.step == 0
            || !state.time_s.is_finite()
            || state.time_s < 0.0
            || !receipt.snapshot_solver_dt_s.is_finite()
            || receipt.snapshot_solver_dt_s <= 0.0
            || !fullmag_quantities::is_canonical_sha256(&receipt.values_sha256)
            || !fullmag_quantities::is_canonical_sha256(native_node_map_sha256)
            || !fullmag_quantities::is_canonical_sha256(native_indexed_geometry_sha256)
        {
            return Err(
                "accepted FEM CPU final state requires a positive native clock and canonical native digests".into(),
            );
        }
        if map.content_sha256()? != native_node_map_sha256 {
            return Err("native node map differs from its snapshot receipt".into());
        }

        let clock = ObservationClock {
            accepted_step: receipt.snapshot_step,
            time_seconds: receipt.snapshot_time_s,
            dt_seconds: Some(receipt.snapshot_solver_dt_s),
        };
        let digests = accepted_state_digests(
            clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
                    canonical_bytes: receipt.values_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
                    canonical_bytes: native_node_map_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
                    canonical_bytes: native_indexed_geometry_sha256.as_bytes(),
                },
            ],
        )
        .map_err(|error| error.to_string())?;
        let snapshot = Self {
            schema_version: FEM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA.into(),
            clock,
            values_sha256: receipt.values_sha256.clone(),
            native_node_map_sha256: native_node_map_sha256.into(),
            native_indexed_geometry_sha256: native_indexed_geometry_sha256.into(),
            clock_digest: digests.clock_digest,
            state_digest: digests.state_digest,
            primary_carrier_ids: FEM_CPU_PRIMARY_CARRIERS
                .iter()
                .map(|carrier| (*carrier).to_owned())
                .collect(),
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != FEM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA
            || !fullmag_quantities::is_canonical_sha256(&self.values_sha256)
            || !fullmag_quantities::is_canonical_sha256(&self.native_node_map_sha256)
            || !fullmag_quantities::is_canonical_sha256(&self.native_indexed_geometry_sha256)
            || self.primary_carrier_ids
                != FEM_CPU_PRIMARY_CARRIERS
                    .iter()
                    .map(|carrier| (*carrier).to_owned())
                    .collect::<Vec<_>>()
        {
            return Err("invalid accepted FEM CPU state snapshot identity".into());
        }
        let digests = accepted_state_digests(
            self.clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
                    canonical_bytes: self.values_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
                    canonical_bytes: self.native_node_map_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
                    canonical_bytes: self.native_indexed_geometry_sha256.as_bytes(),
                },
            ],
        )
        .map_err(|error| error.to_string())?;
        if self.clock_digest != digests.clock_digest || self.state_digest != digests.state_digest {
            return Err("accepted FEM CPU state digest does not match its carriers".into());
        }
        Ok(())
    }

    pub(crate) fn to_accepted_state_ref(
        &self,
        run_id: &str,
        stage_id: &str,
        runtime_epoch: u64,
        domain_digest: &str,
        plan_digest: &str,
    ) -> Result<AcceptedStateRef, String> {
        self.validate()?;
        if domain_digest.is_empty() || plan_digest.is_empty() {
            return Err("accepted FEM CPU state requires domain and plan digests".into());
        }
        let identity = AcceptedStateId::from_canonical_state(
            run_id.to_owned(),
            Some(stage_id.to_owned()),
            self.clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
                    canonical_bytes: self.values_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
                    canonical_bytes: self.native_node_map_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_CPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
                    canonical_bytes: self.native_indexed_geometry_sha256.as_bytes(),
                },
            ],
            domain_digest.to_owned(),
            plan_digest.to_owned(),
        )
        .map_err(|error| error.to_string())?;
        Ok(AcceptedStateRef {
            id: identity,
            generation: AcceptedStateGeneration {
                runtime_epoch,
                accepted_revision: self.clock.accepted_step,
            },
        })
    }
}
