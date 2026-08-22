//! Activation metadata for durable hard constraints.

use serde::{Deserialize, Serialize};
use std::fmt;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrozenSpinsActivationError {
    StaleState,
    TopologyMismatch { expected: String, found: String },
    SourceRevisionMismatch { expected: Option<u64>, found: Option<u64> },
    MaskLengthMismatch { expected: usize, found: usize },
    ReferenceLengthMismatch { expected: usize, found: usize },
    NonFiniteReference,
    EmptySelection,
    AllDofsFrozen,
    EpochInvalid,
    TopologyFingerprintMissing,
    Invalid(String),
}

impl fmt::Display for FrozenSpinsActivationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StaleState => f.write_str("frozen_spins_activation_stale_state"),
            Self::TopologyMismatch { expected, found } => write!(
                f,
                "frozen_spins_activation_topology_mismatch: expected {expected}, found {found}"
            ),
            Self::SourceRevisionMismatch { expected, found } => write!(
                f,
                "frozen_spins_activation_source_revision_mismatch: expected {expected:?}, found {found:?}"
            ),
            Self::MaskLengthMismatch { expected, found } => write!(
                f,
                "frozen_spins_activation_mask_length_mismatch: expected {expected}, found {found}"
            ),
            Self::ReferenceLengthMismatch { expected, found } => write!(
                f,
                "frozen_spins_activation_reference_length_mismatch: expected {expected}, found {found}"
            ),
            Self::NonFiniteReference => f.write_str("frozen_spins_activation_non_finite_reference"),
            Self::EmptySelection => f.write_str("frozen_spins_activation_empty_selection"),
            Self::AllDofsFrozen => f.write_str("frozen_spins_activation_all_dofs_frozen"),
            Self::EpochInvalid => f.write_str("frozen_spins_activation_epoch_invalid"),
            Self::TopologyFingerprintMissing => {
                f.write_str("frozen_spins_activation_topology_fingerprint_missing")
            }
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for FrozenSpinsActivationError {}

impl FrozenSpinsActivation {
    pub fn new(
        epoch: u64,
        membership_policy: impl Into<String>,
        source_state_revision: Option<u64>,
        topology_fingerprint: impl Into<String>,
    ) -> Result<Self, FrozenSpinsActivationError> {
        if epoch == 0 {
            return Err(FrozenSpinsActivationError::EpochInvalid);
        }
        let topology_fingerprint = topology_fingerprint.into();
        if topology_fingerprint.is_empty() {
            return Err(FrozenSpinsActivationError::TopologyFingerprintMissing);
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

/// Snapshot of the runtime state read during the first phase of activation.
#[derive(Debug, Clone, PartialEq)]
pub struct FrozenSpinsActivationSnapshot {
    pub model_revision: u64,
    pub source_state_revision: Option<u64>,
    pub topology_fingerprint: String,
    pub constraint_revision: u64,
    pub total_dofs: usize,
}

impl FrozenSpinsActivationSnapshot {
    pub fn validate_preconditions(
        &self,
        expected_model_revision: Option<u64>,
        expected_source_state_revision: Option<u64>,
        expected_topology_fingerprint: Option<&str>,
    ) -> Result<(), FrozenSpinsActivationError> {
        if let Some(expected_model) = expected_model_revision {
            if self.model_revision != expected_model {
                return Err(FrozenSpinsActivationError::StaleState);
            }
        }
        if let Some(expected_source) = expected_source_state_revision {
            if self.source_state_revision != Some(expected_source) {
                return Err(FrozenSpinsActivationError::SourceRevisionMismatch {
                    expected: Some(expected_source),
                    found: self.source_state_revision,
                });
            }
        }
        if let Some(expected_topology) = expected_topology_fingerprint {
            if self.topology_fingerprint != expected_topology {
                return Err(FrozenSpinsActivationError::TopologyMismatch {
                    expected: expected_topology.to_string(),
                    found: self.topology_fingerprint.clone(),
                });
            }
        }
        Ok(())
    }

    pub fn commit_check(
        &self,
        current: &FrozenSpinsActivationSnapshot,
    ) -> Result<(), FrozenSpinsActivationError> {
        if self.model_revision != current.model_revision
            || self.source_state_revision != current.source_state_revision
            || self.topology_fingerprint != current.topology_fingerprint
            || self.constraint_revision != current.constraint_revision
            || self.total_dofs != current.total_dofs
        {
            return Err(FrozenSpinsActivationError::StaleState);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_creation_validates_epoch_and_topology() {
        assert_eq!(
            FrozenSpinsActivation::new(0, "static", Some(1), "grid"),
            Err(FrozenSpinsActivationError::EpochInvalid)
        );
        assert_eq!(
            FrozenSpinsActivation::new(1, "static", Some(1), ""),
            Err(FrozenSpinsActivationError::TopologyFingerprintMissing)
        );
        let valid = FrozenSpinsActivation::new(1, "static", Some(3), "fingerprint-1").unwrap();
        assert_eq!(valid.epoch, 1);
        assert_eq!(valid.topology_fingerprint, "fingerprint-1");
        assert_eq!(valid.source_state_revision, Some(3));
    }

    #[test]
    fn activation_snapshot_validates_and_detects_stale_commit() {
        let snapshot = FrozenSpinsActivationSnapshot {
            model_revision: 5,
            source_state_revision: Some(10),
            topology_fingerprint: "grid-sha".to_string(),
            constraint_revision: 2,
            total_dofs: 100,
        };

        assert!(snapshot
            .validate_preconditions(Some(5), Some(10), Some("grid-sha"))
            .is_ok());

        assert_eq!(
            snapshot.validate_preconditions(Some(6), Some(10), Some("grid-sha")),
            Err(FrozenSpinsActivationError::StaleState)
        );

        assert!(matches!(
            snapshot.validate_preconditions(Some(5), Some(11), Some("grid-sha")),
            Err(FrozenSpinsActivationError::SourceRevisionMismatch { .. })
        ));

        assert!(matches!(
            snapshot.validate_preconditions(Some(5), Some(10), Some("other-grid")),
            Err(FrozenSpinsActivationError::TopologyMismatch { .. })
        ));

        let matching_current = snapshot.clone();
        assert!(snapshot.commit_check(&matching_current).is_ok());

        let mut stale_current = snapshot.clone();
        stale_current.source_state_revision = Some(11);
        assert_eq!(
            snapshot.commit_check(&stale_current),
            Err(FrozenSpinsActivationError::StaleState)
        );
    }
}
