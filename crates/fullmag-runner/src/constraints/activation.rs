//! Activation metadata for durable hard constraints.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const FROZEN_SPINS_ACTIVATION_SCHEMA: &str = "fullmag.frozen_spins.activation.v1";
pub const FROZEN_SPINS_RUNTIME_STATUS_SCHEMA: &str = "fullmag.frozen_spins.runtime-status.v1";

/// Lightweight solver-owned activation certificate suitable for status and
/// realtime telemetry. The dense mask and reference remain in the field/data
/// plane; status carries only their identities and scalar counts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrozenSpinsRuntimeStatus {
    pub schema: String,
    pub constraint_activation_epochs: BTreeMap<String, u64>,
    pub active_constraint_ids: BTreeSet<String>,
    pub resolved_constraint_set_revision: u64,
    pub topology_fingerprint: String,
    pub source_state_revision: Option<u64>,
    pub mask_sha256: String,
    pub reference_sha256: String,
    pub active_site_count: u64,
    pub frozen_site_count: u64,
    pub free_site_count: u64,
    pub vector_dimension: u8,
    pub scalar_component_dof_count: u64,
}

impl FrozenSpinsRuntimeStatus {
    pub fn from_resolved_state(
        plan: &fullmag_ir::ResolvedFrozenSpinsPlanIR,
        state: &fullmag_engine::FrozenSpinsState,
    ) -> Self {
        let reference_sha256 = runtime_reference_sha256(state.mask(), state.reference());
        let mut mask_hash = Sha256::new();
        mask_hash.update((state.mask().len() as u64).to_le_bytes());
        mask_hash.update(
            state
                .mask()
                .iter()
                .map(|value| u8::from(*value))
                .collect::<Vec<_>>(),
        );
        Self {
            schema: FROZEN_SPINS_RUNTIME_STATUS_SCHEMA.to_string(),
            constraint_activation_epochs: state.constraint_activation_epochs().clone(),
            active_constraint_ids: state.active_constraint_ids().clone(),
            resolved_constraint_set_revision: state.resolved_constraint_set_revision(),
            topology_fingerprint: plan.grid_or_mesh_fingerprint.clone(),
            source_state_revision: plan.source_state_revision,
            mask_sha256: format!("{:x}", mask_hash.finalize()),
            reference_sha256,
            active_site_count: plan.active_dof_count,
            frozen_site_count: state.frozen_dof_count() as u64,
            free_site_count: state.free_dof_count() as u64,
            vector_dimension: 3,
            scalar_component_dof_count: plan.active_dof_count.saturating_mul(3),
        }
    }
}

fn runtime_reference_sha256(mask: &[bool], reference: &[[f64; 3]]) -> String {
    debug_assert_eq!(mask.len(), reference.len());
    let mut hash = Sha256::new();
    hash.update((mask.len() as u64).to_le_bytes());
    for (selected, value) in mask.iter().zip(reference) {
        hash.update([u8::from(*selected)]);
        if *selected {
            for component in value {
                hash.update(component.to_bits().to_le_bytes());
            }
        }
    }
    format!("{:x}", hash.finalize())
}

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

/// Runtime owner of per-constraint activation epochs and the revision of the
/// complete resolved active set. Epochs survive temporary stage deactivation;
/// re-entry therefore receives a new epoch instead of recapturing as epoch 1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrozenSpinsActivationSet {
    pub resolved_constraint_set_revision: u64,
    pub constraint_activation_epochs: BTreeMap<String, u64>,
    pub active_constraint_ids: BTreeSet<String>,
}

impl Default for FrozenSpinsActivationSet {
    fn default() -> Self {
        Self {
            resolved_constraint_set_revision: 0,
            constraint_activation_epochs: BTreeMap::new(),
            active_constraint_ids: BTreeSet::new(),
        }
    }
}

impl FrozenSpinsActivationSet {
    /// Prepare a new resolved set without mutating the currently published
    /// state. Continuing constraints keep their epoch; newly active and
    /// re-entering constraints advance their own epoch exactly once.
    pub fn prepare_transition(
        &self,
        active_constraint_ids: impl IntoIterator<Item = String>,
    ) -> Result<Self, FrozenSpinsActivationError> {
        let active_constraint_ids = active_constraint_ids.into_iter().collect::<BTreeSet<_>>();
        if active_constraint_ids.iter().any(|id| id.trim().is_empty()) {
            return Err(FrozenSpinsActivationError::Invalid(
                "frozen_spins_activation_constraint_id_invalid".to_string(),
            ));
        }
        let mut constraint_activation_epochs = self.constraint_activation_epochs.clone();
        for id in &active_constraint_ids {
            if !self.active_constraint_ids.contains(id) {
                let next = constraint_activation_epochs
                    .get(id)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or_else(|| {
                        FrozenSpinsActivationError::Invalid(
                            "frozen_spins_activation_epoch_overflow".to_string(),
                        )
                    })?;
                constraint_activation_epochs.insert(id.clone(), next);
            }
        }
        let resolved_constraint_set_revision = self
            .resolved_constraint_set_revision
            .checked_add(1)
            .ok_or_else(|| {
                FrozenSpinsActivationError::Invalid(
                    "frozen_spins_resolved_constraint_set_revision_overflow".to_string(),
                )
            })?;
        Ok(Self {
            resolved_constraint_set_revision,
            constraint_activation_epochs,
            active_constraint_ids,
        })
    }

    pub fn epoch(&self, constraint_id: &str) -> Option<u64> {
        self.constraint_activation_epochs
            .get(constraint_id)
            .copied()
    }

    /// Prepare an explicit authoring reactivation. Every active constraint
    /// advances even when its ID and resolved mask are unchanged, because
    /// CaptureCurrentAtActivation replaces the solver-owned reference.
    pub fn prepare_reactivation(
        &self,
        active_constraint_ids: impl IntoIterator<Item = String>,
    ) -> Result<Self, FrozenSpinsActivationError> {
        let active_constraint_ids = active_constraint_ids.into_iter().collect::<BTreeSet<_>>();
        if active_constraint_ids.iter().any(|id| id.trim().is_empty()) {
            return Err(FrozenSpinsActivationError::Invalid(
                "frozen_spins_activation_constraint_id_invalid".to_string(),
            ));
        }
        let mut constraint_activation_epochs = self.constraint_activation_epochs.clone();
        for id in &active_constraint_ids {
            let next = constraint_activation_epochs
                .get(id)
                .copied()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| {
                    FrozenSpinsActivationError::Invalid(
                        "frozen_spins_activation_epoch_overflow".to_string(),
                    )
                })?;
            constraint_activation_epochs.insert(id.clone(), next);
        }
        let resolved_constraint_set_revision = self
            .resolved_constraint_set_revision
            .checked_add(1)
            .ok_or_else(|| {
                FrozenSpinsActivationError::Invalid(
                    "frozen_spins_resolved_constraint_set_revision_overflow".to_string(),
                )
            })?;
        Ok(Self {
            resolved_constraint_set_revision,
            constraint_activation_epochs,
            active_constraint_ids,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrozenSpinsActivationError {
    StaleState,
    TopologyMismatch {
        expected: String,
        found: String,
    },
    SourceRevisionMismatch {
        expected: Option<u64>,
        found: Option<u64>,
    },
    MaskLengthMismatch {
        expected: usize,
        found: usize,
    },
    ReferenceLengthMismatch {
        expected: usize,
        found: usize,
    },
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
    fn runtime_reference_identity_matches_resolved_certificate_encoding() {
        let mask = [true, false, true];
        let reference: [[f64; 3]; 3] = [[1.0, 2.0, 3.0], [9.0, 8.0, 7.0], [-1.0, -2.0, -3.0]];
        let mut expected = Sha256::new();
        expected.update(3_u64.to_le_bytes());
        expected.update([1]);
        for component in reference[0] {
            expected.update(component.to_bits().to_le_bytes());
        }
        expected.update([0]);
        expected.update([1]);
        for component in reference[2] {
            expected.update(component.to_bits().to_le_bytes());
        }
        assert_eq!(
            runtime_reference_sha256(&mask, &reference),
            format!("{:x}", expected.finalize())
        );

        let changed_free_reference: [[f64; 3]; 3] =
            [[1.0, 2.0, 3.0], [90.0, 80.0, 70.0], [-1.0, -2.0, -3.0]];
        assert_eq!(
            runtime_reference_sha256(&mask, &reference),
            runtime_reference_sha256(&mask, &changed_free_reference)
        );
    }

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

    #[test]
    fn activation_set_tracks_per_constraint_epochs_and_resolved_set_revision() {
        let initial = FrozenSpinsActivationSet::default()
            .prepare_transition(["always".to_string(), "stage-a".to_string()])
            .unwrap();
        assert_eq!(initial.resolved_constraint_set_revision, 1);
        assert_eq!(initial.epoch("always"), Some(1));
        assert_eq!(initial.epoch("stage-a"), Some(1));

        let stage_b = initial
            .prepare_transition(["always".to_string(), "stage-b".to_string()])
            .unwrap();
        assert_eq!(stage_b.resolved_constraint_set_revision, 2);
        assert_eq!(stage_b.epoch("always"), Some(1));
        assert_eq!(stage_b.epoch("stage-a"), Some(1));
        assert_eq!(stage_b.epoch("stage-b"), Some(1));

        let reentered = stage_b
            .prepare_transition(["always".to_string(), "stage-a".to_string()])
            .unwrap();
        assert_eq!(reentered.resolved_constraint_set_revision, 3);
        assert_eq!(reentered.epoch("always"), Some(1));
        assert_eq!(reentered.epoch("stage-a"), Some(2));
        assert_eq!(reentered.epoch("stage-b"), Some(1));

        let explicitly_reactivated = reentered
            .prepare_reactivation(["always".to_string(), "stage-a".to_string()])
            .unwrap();
        assert_eq!(explicitly_reactivated.resolved_constraint_set_revision, 4);
        assert_eq!(explicitly_reactivated.epoch("always"), Some(2));
        assert_eq!(explicitly_reactivated.epoch("stage-a"), Some(3));
        assert_eq!(explicitly_reactivated.epoch("stage-b"), Some(1));
    }
}
