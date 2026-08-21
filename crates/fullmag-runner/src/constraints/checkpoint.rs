//! Versioned Frozen Spins checkpoint codec.

use super::activation::FrozenSpinsActivation;
use fullmag_engine::{FrozenSpinsState, Vector3};
use fullmag_ir::{ResolvedFrozenSpinsPlanIR, SelectionAuthoredFingerprintIR};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const FROZEN_SPINS_CHECKPOINT_SCHEMA: &str = "fullmag.frozen_spins.checkpoint.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenSpinsCheckpointV1 {
    pub schema: String,
    pub constraint_ids: Vec<String>,
    pub authored_fingerprints: Vec<SelectionAuthoredFingerprintIR>,
    pub activation: FrozenSpinsActivation,
    pub mask_len: usize,
    /// Dense mask packed least-significant-bit first, eight cells per byte.
    pub mask_bits: Vec<u8>,
    pub mask_sha256: String,
    pub reference: Vec<Vector3>,
    pub reference_sha256: String,
    pub active_dof_count: u64,
    pub frozen_dof_count: u64,
    pub free_dof_count: u64,
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub step: u64,
    pub time_s: f64,
    pub dt: f64,
    pub magnetization: Vec<Vector3>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrozenSpinsCheckpointError {
    Invalid(String),
    TopologyMismatch { expected: String, found: String },
    MaskMismatch,
    ConstraintIdentityMismatch,
    StateLengthMismatch { expected: usize, found: usize },
}

impl fmt::Display for FrozenSpinsCheckpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::TopologyMismatch { expected, found } => write!(
                f,
                "frozen_spins_checkpoint_topology_mismatch: expected {expected}, found {found}"
            ),
            Self::MaskMismatch => f.write_str("frozen_spins_checkpoint_mask_mismatch"),
            Self::ConstraintIdentityMismatch => {
                f.write_str("frozen_spins_checkpoint_constraint_identity_mismatch")
            }
            Self::StateLengthMismatch { expected, found } => write!(
                f,
                "frozen_spins_checkpoint_state_length_mismatch: expected {expected}, found {found}"
            ),
        }
    }
}

impl std::error::Error for FrozenSpinsCheckpointError {}

impl FrozenSpinsCheckpointV1 {
    /// Validate the self-contained shape and integrity of a checkpoint when
    /// no resolved plan is available (for example while loading a session
    /// persistence record). Plan/topology identity is checked separately by
    /// `validate_for_plan` at the execution boundary.
    pub fn validate_structure(
        &self,
        expected_vector_count: usize,
    ) -> Result<(), FrozenSpinsCheckpointError> {
        if self.schema != FROZEN_SPINS_CHECKPOINT_SCHEMA {
            return Err(FrozenSpinsCheckpointError::Invalid(
                "frozen_spins_checkpoint_schema_unsupported".to_string(),
            ));
        }
        if self.mask_len != expected_vector_count
            || self.reference.len() != expected_vector_count
            || self.magnetization.len() != expected_vector_count
        {
            return Err(FrozenSpinsCheckpointError::StateLengthMismatch {
                expected: expected_vector_count,
                found: self
                    .reference
                    .len()
                    .min(self.magnetization.len())
                    .min(self.mask_len),
            });
        }
        let mask = unpack_mask(&self.mask_bits, self.mask_len)?;
        let frozen_dof_count = mask.iter().filter(|value| **value).count() as u64;
        if frozen_dof_count != self.frozen_dof_count
            || self.free_dof_count > self.mask_len as u64 - frozen_dof_count
            || self.active_dof_count < frozen_dof_count + self.free_dof_count
            || self.active_dof_count > self.mask_len as u64
            || self.mask_sha256 != mask_sha256(&mask)
            || self.reference_sha256 != reference_sha256(&self.reference)
            || self.activation.schema != super::activation::FROZEN_SPINS_ACTIVATION_SCHEMA
            || self.activation.epoch == 0
            || self.activation.topology_fingerprint.is_empty()
        {
            return Err(FrozenSpinsCheckpointError::Invalid(
                "frozen_spins_checkpoint_payload_integrity_mismatch".to_string(),
            ));
        }
        if !self
            .reference
            .iter()
            .chain(&self.magnetization)
            .flatten()
            .all(|value| value.is_finite())
            || !self.time_s.is_finite()
            || !self.dt.is_finite()
            || self.dt < 0.0
        {
            return Err(FrozenSpinsCheckpointError::Invalid(
                "frozen_spins_checkpoint_non_finite_state".to_string(),
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_runtime(
        plan: &ResolvedFrozenSpinsPlanIR,
        frozen: &FrozenSpinsState,
        magnetization: &[Vector3],
        step: u64,
        time_s: f64,
        dt: f64,
        backend: impl Into<String>,
        device: impl Into<String>,
        precision: impl Into<String>,
    ) -> Result<Self, FrozenSpinsCheckpointError> {
        if frozen.len() != plan.frozen_mask.len() || magnetization.len() != frozen.len() {
            return Err(FrozenSpinsCheckpointError::StateLengthMismatch {
                expected: plan.frozen_mask.len(),
                found: frozen.len().min(magnetization.len()),
            });
        }
        if frozen.mask() != plan.frozen_mask.as_slice() {
            return Err(FrozenSpinsCheckpointError::MaskMismatch);
        }
        let activation = FrozenSpinsActivation::new(
            frozen.activation_epoch(),
            "resolved_at_activation",
            plan.source_state_revision,
            plan.grid_or_mesh_fingerprint.clone(),
        )
        .map_err(FrozenSpinsCheckpointError::Invalid)?;
        let mask_bits = pack_mask(frozen.mask());
        let reference = frozen.reference().to_vec();
        let checkpoint = Self {
            schema: FROZEN_SPINS_CHECKPOINT_SCHEMA.to_string(),
            constraint_ids: plan.constraint_ids.clone(),
            authored_fingerprints: plan.certificate.authored_fingerprints.clone(),
            activation,
            mask_len: frozen.len(),
            mask_bits,
            mask_sha256: plan.mask_sha256.clone(),
            reference_sha256: reference_sha256(&reference),
            reference,
            active_dof_count: plan.active_dof_count,
            frozen_dof_count: plan.frozen_dof_count,
            free_dof_count: plan.free_dof_count,
            backend: backend.into(),
            device: device.into(),
            precision: precision.into(),
            step,
            time_s,
            dt,
            magnetization: magnetization.to_vec(),
        };
        checkpoint.validate_for_plan(plan)?;
        Ok(checkpoint)
    }

    pub fn validate_for_plan(
        &self,
        plan: &ResolvedFrozenSpinsPlanIR,
    ) -> Result<(), FrozenSpinsCheckpointError> {
        if self.schema != FROZEN_SPINS_CHECKPOINT_SCHEMA {
            return Err(FrozenSpinsCheckpointError::Invalid(
                "frozen_spins_checkpoint_schema_unsupported".to_string(),
            ));
        }
        if self.constraint_ids != plan.constraint_ids
            || self.authored_fingerprints != plan.certificate.authored_fingerprints
        {
            return Err(FrozenSpinsCheckpointError::ConstraintIdentityMismatch);
        }
        if self.activation.topology_fingerprint != plan.grid_or_mesh_fingerprint {
            return Err(FrozenSpinsCheckpointError::TopologyMismatch {
                expected: plan.grid_or_mesh_fingerprint.clone(),
                found: self.activation.topology_fingerprint.clone(),
            });
        }
        if self.activation.source_state_revision != plan.source_state_revision {
            return Err(FrozenSpinsCheckpointError::Invalid(
                "frozen_spins_checkpoint_source_revision_mismatch".to_string(),
            ));
        }
        if self.mask_len != plan.frozen_mask.len()
            || self.mask_sha256 != plan.mask_sha256
            || unpack_mask(&self.mask_bits, self.mask_len)? != plan.frozen_mask
        {
            return Err(FrozenSpinsCheckpointError::MaskMismatch);
        }
        if self.reference.len() != self.mask_len || self.magnetization.len() != self.mask_len {
            return Err(FrozenSpinsCheckpointError::StateLengthMismatch {
                expected: self.mask_len,
                found: self.reference.len().min(self.magnetization.len()),
            });
        }
        if self.reference_sha256 != reference_sha256(&self.reference)
            || self.frozen_dof_count != plan.frozen_dof_count
            || self.free_dof_count != plan.free_dof_count
            || self.active_dof_count != plan.active_dof_count
            || self.activation.epoch == 0
        {
            return Err(FrozenSpinsCheckpointError::Invalid(
                "frozen_spins_checkpoint_payload_integrity_mismatch".to_string(),
            ));
        }
        if !self
            .reference
            .iter()
            .chain(&self.magnetization)
            .flatten()
            .all(|value| value.is_finite())
            || !self.time_s.is_finite()
            || !self.dt.is_finite()
            || self.dt < 0.0
        {
            return Err(FrozenSpinsCheckpointError::Invalid(
                "frozen_spins_checkpoint_non_finite_state".to_string(),
            ));
        }
        Ok(())
    }

    pub fn restore_engine_state(
        &self,
        plan: &ResolvedFrozenSpinsPlanIR,
    ) -> Result<FrozenSpinsState, FrozenSpinsCheckpointError> {
        self.validate_for_plan(plan)?;
        FrozenSpinsState::from_checkpoint(
            unpack_mask(&self.mask_bits, self.mask_len)?,
            self.reference.clone(),
            self.frozen_dof_count as usize,
            self.free_dof_count as usize,
            self.activation.epoch,
        )
        .map_err(|error| FrozenSpinsCheckpointError::Invalid(error.to_string()))
    }
}

fn pack_mask(mask: &[bool]) -> Vec<u8> {
    let mut bytes = vec![0; mask.len().div_ceil(8)];
    for (index, value) in mask.iter().enumerate() {
        if *value {
            bytes[index / 8] |= 1 << (index % 8);
        }
    }
    bytes
}

fn unpack_mask(bytes: &[u8], len: usize) -> Result<Vec<bool>, FrozenSpinsCheckpointError> {
    if bytes.len() != len.div_ceil(8) {
        return Err(FrozenSpinsCheckpointError::Invalid(
            "frozen_spins_checkpoint_mask_storage_length_mismatch".to_string(),
        ));
    }
    Ok((0..len)
        .map(|index| bytes[index / 8] & (1 << (index % 8)) != 0)
        .collect())
}

fn reference_sha256(reference: &[Vector3]) -> String {
    let mut hash = Sha256::new();
    hash.update((reference.len() as u64).to_le_bytes());
    for value in reference {
        for component in value {
            hash.update(component.to_bits().to_le_bytes());
        }
    }
    format!("{:x}", hash.finalize())
}

fn mask_sha256(mask: &[bool]) -> String {
    let mut hash = Sha256::new();
    hash.update((mask.len() as u64).to_le_bytes());
    hash.update(
        mask.iter()
            .map(|value| u8::from(*value))
            .collect::<Vec<_>>(),
    );
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        SelectionCertificateIR, RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION,
        SELECTION_CERTIFICATE_SCHEMA_VERSION,
    };

    fn plan(mask: Vec<bool>) -> ResolvedFrozenSpinsPlanIR {
        let frozen = mask.iter().filter(|value| **value).count() as u64;
        let active = mask.len() as u64;
        let free = active - frozen;
        let mut hash = Sha256::new();
        hash.update((mask.len() as u64).to_le_bytes());
        hash.update(
            mask.iter()
                .map(|value| u8::from(*value))
                .collect::<Vec<_>>(),
        );
        let mask_sha256 = format!("{:x}", hash.finalize());
        let fingerprint = SelectionAuthoredFingerprintIR {
            constraint_id: "frozen".to_string(),
            selector_sha256: "a".repeat(64),
        };
        let certificate = SelectionCertificateIR {
            schema_version: SELECTION_CERTIFICATE_SCHEMA_VERSION.to_string(),
            evaluator_id: "selection.fdm_cell_center.v1".to_string(),
            constraint_ids: vec!["frozen".to_string()],
            authored_fingerprints: vec![fingerprint],
            raw_candidate_dof_count: frozen,
            inactive_candidate_dof_count: 0,
            active_dof_count: active,
            frozen_dof_count: frozen,
            free_dof_count: free,
            bounds_m: None,
            grid_or_mesh_fingerprint: "grid".to_string(),
            source_state_revision: Some(7),
            mask_sha256: mask_sha256.clone(),
            resolved_reference_sha256: "b".repeat(64),
            warnings: Vec::new(),
        };
        ResolvedFrozenSpinsPlanIR {
            schema_version: RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION.to_string(),
            constraint_ids: vec!["frozen".to_string()],
            frozen_mask: mask,
            active_dof_count: active,
            frozen_dof_count: frozen,
            free_dof_count: free,
            mask_sha256,
            grid_or_mesh_fingerprint: "grid".to_string(),
            source_state_revision: Some(7),
            all_active_dofs_frozen: active > 0 && free == 0,
            certificate,
        }
    }

    #[test]
    fn checkpoint_round_trip_packs_mask_and_restores_engine_state() {
        let plan = plan(vec![
            true, false, true, false, false, true, false, true, true,
        ]);
        let state =
            FrozenSpinsState::capture_at_activation(&plan, None, &[[1.0, 0.0, 0.0]; 9]).unwrap();
        let checkpoint = FrozenSpinsCheckpointV1::from_runtime(
            &plan,
            &state,
            &[[1.0, 0.0, 0.0]; 9],
            11,
            2e-9,
            1e-12,
            "fdm_cpu_reference",
            "cpu",
            "double",
        )
        .unwrap();
        let encoded = serde_json::to_vec(&checkpoint).unwrap();
        let decoded: FrozenSpinsCheckpointV1 = serde_json::from_slice(&encoded).unwrap();
        let restored = decoded.restore_engine_state(&plan).unwrap();
        assert_eq!(restored.mask(), state.mask());
        assert_eq!(restored.reference(), state.reference());
        assert_eq!(decoded.step, 11);
        assert!(decoded.mask_bits.len() < decoded.mask_len);
    }

    #[test]
    fn checkpoint_rejects_topology_change_before_restore() {
        let plan = plan(vec![true, false]);
        let state =
            FrozenSpinsState::capture_at_activation(&plan, None, &[[1.0, 0.0, 0.0]; 2]).unwrap();
        let mut checkpoint = FrozenSpinsCheckpointV1::from_runtime(
            &plan,
            &state,
            &[[1.0, 0.0, 0.0]; 2],
            1,
            0.0,
            1e-12,
            "fdm_cpu_reference",
            "cpu",
            "double",
        )
        .unwrap();
        checkpoint.activation.topology_fingerprint = "different-grid".to_string();
        assert!(matches!(
            checkpoint.restore_engine_state(&plan),
            Err(FrozenSpinsCheckpointError::TopologyMismatch { .. })
        ));
    }
}
