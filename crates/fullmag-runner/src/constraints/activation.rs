//! Activation metadata for durable hard constraints.

use serde::{Deserialize, Serialize};

pub const FROZEN_SPINS_ACTIVATION_SCHEMA: &str = "fullmag.frozen_spins.activation.v1";

/// Immutable activation identity attached to a resolved constraint state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrozenSpinsActivation {
    pub schema: String,
    pub epoch: u64,
    pub membership_policy: String,
    pub source_state_revision: Option<u64>,
    pub topology_fingerprint: String,
}

impl FrozenSpinsActivation {
    pub fn new(
        epoch: u64,
        membership_policy: impl Into<String>,
        source_state_revision: Option<u64>,
        topology_fingerprint: impl Into<String>,
    ) -> Result<Self, String> {
        if epoch == 0 {
            return Err("frozen_spins_activation_epoch_invalid".to_string());
        }
        let topology_fingerprint = topology_fingerprint.into();
        if topology_fingerprint.is_empty() {
            return Err("frozen_spins_activation_topology_fingerprint_missing".to_string());
        }
        Ok(Self {
            schema: FROZEN_SPINS_ACTIVATION_SCHEMA.to_string(),
            epoch,
            membership_policy: membership_policy.into(),
            source_state_revision,
            topology_fingerprint,
        })
    }
}
