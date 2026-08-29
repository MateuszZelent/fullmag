//! Runtime ownership for the resolved FDM frozen-spin constraint.

use crate::{EngineError, Result, Vector3, VectorFieldSoA};
use fullmag_ir::ResolvedFrozenSpinsPlanIR;
use std::collections::{BTreeMap, BTreeSet};

/// Dense reference-state constraint captured atomically at stage activation.
#[derive(Debug, Clone, PartialEq)]
pub struct FrozenSpinsState {
    frozen_mask: Vec<bool>,
    reference: Vec<Vector3>,
    frozen_dof_count: usize,
    free_dof_count: usize,
    activation_epoch: u64,
    constraint_activation_epochs: BTreeMap<String, u64>,
    active_constraint_ids: BTreeSet<String>,
    resolved_constraint_set_revision: u64,
}

impl FrozenSpinsState {
    /// Capture the normalized stable solver state after the planner has
    /// certified the dense active-domain mask.
    pub fn capture_at_activation(
        plan: &ResolvedFrozenSpinsPlanIR,
        active_mask: Option<&[bool]>,
        state: &[Vector3],
    ) -> Result<Self> {
        if plan.frozen_mask.len() != state.len() {
            return Err(EngineError::new(format!(
                "frozen_spins_mask_size_mismatch: frozen mask length {} differs from state length {}",
                plan.frozen_mask.len(),
                state.len()
            )));
        }
        let active = active_mask
            .map(|mask| mask.to_vec())
            .unwrap_or_else(|| vec![true; state.len()]);
        plan.validate_against_active_mask(&active)
            .map_err(EngineError::new)?;
        let frozen_dof_count = plan.frozen_mask.iter().filter(|frozen| **frozen).count();
        let free_dof_count = active
            .iter()
            .zip(&plan.frozen_mask)
            .filter(|(active, frozen)| **active && !**frozen)
            .count();
        if frozen_dof_count != plan.frozen_dof_count as usize
            || free_dof_count != plan.free_dof_count as usize
        {
            return Err(EngineError::new(
                "frozen_spins_resolved_count_mismatch: certified counts do not match runtime domain",
            ));
        }
        Ok(Self {
            frozen_mask: plan.frozen_mask.clone(),
            reference: state.to_vec(),
            frozen_dof_count,
            free_dof_count,
            activation_epoch: 1,
            constraint_activation_epochs: plan
                .constraint_ids
                .iter()
                .cloned()
                .map(|id| (id, 1))
                .collect(),
            active_constraint_ids: plan.constraint_ids.iter().cloned().collect(),
            resolved_constraint_set_revision: 1,
        })
    }

    /// Atomically prepare the constraint state for a later stage activation.
    /// Constraints that remain active keep their epoch; newly active or
    /// re-entering constraints advance their own epoch. The caller publishes
    /// the returned value only after its revision/topology commit check.
    pub fn transition_at_activation(
        previous: &Self,
        plan: &ResolvedFrozenSpinsPlanIR,
        active_mask: Option<&[bool]>,
        state: &[Vector3],
    ) -> Result<Self> {
        let mut next = Self::capture_at_activation(plan, active_mask, state)?;
        next.constraint_activation_epochs = previous.constraint_activation_epochs.clone();
        next.active_constraint_ids = plan.constraint_ids.iter().cloned().collect();
        for id in &next.active_constraint_ids {
            if !previous.active_constraint_ids.contains(id) {
                let epoch = next
                    .constraint_activation_epochs
                    .get(id)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or_else(|| EngineError::new("frozen_spins_activation_epoch_overflow"))?;
                next.constraint_activation_epochs.insert(id.clone(), epoch);
            }
        }
        next.resolved_constraint_set_revision = previous
            .resolved_constraint_set_revision
            .checked_add(1)
            .ok_or_else(|| {
                EngineError::new("frozen_spins_resolved_constraint_set_revision_overflow")
            })?;
        next.activation_epoch = next
            .active_constraint_ids
            .iter()
            .filter_map(|id| next.constraint_activation_epochs.get(id).copied())
            .max()
            .unwrap_or(1);
        Ok(next)
    }

    /// Restore a previously activated constraint from a durable checkpoint.
    ///
    /// The caller is responsible for validating the plan/topology identity
    /// before invoking this constructor. The constructor still validates all
    /// dense lengths and certified counts so malformed checkpoint payloads
    /// cannot enter the solver state.
    pub fn from_checkpoint(
        frozen_mask: Vec<bool>,
        reference: Vec<Vector3>,
        frozen_dof_count: usize,
        free_dof_count: usize,
        activation_epoch: u64,
    ) -> Result<Self> {
        if frozen_mask.len() != reference.len() {
            return Err(EngineError::new(
                "frozen_spins_checkpoint_mask_reference_length_mismatch",
            ));
        }
        let observed_frozen_dof_count = frozen_mask.iter().filter(|frozen| **frozen).count();
        if observed_frozen_dof_count != frozen_dof_count {
            return Err(EngineError::new(
                "frozen_spins_checkpoint_frozen_count_mismatch",
            ));
        }
        // The dense mask also contains inactive cells.  They are neither
        // frozen nor free, so a checkpoint cannot infer the free count from
        // `mask.len() - frozen_dof_count` without the active-domain mask.
        let maximum_free_dof_count = frozen_mask.len().saturating_sub(frozen_dof_count);
        if free_dof_count > maximum_free_dof_count {
            return Err(EngineError::new(
                "frozen_spins_checkpoint_free_count_mismatch",
            ));
        }
        if activation_epoch == 0 {
            return Err(EngineError::new(
                "frozen_spins_checkpoint_activation_epoch_invalid",
            ));
        }
        Ok(Self {
            frozen_mask,
            reference,
            frozen_dof_count,
            free_dof_count,
            activation_epoch,
            constraint_activation_epochs: BTreeMap::new(),
            active_constraint_ids: BTreeSet::new(),
            resolved_constraint_set_revision: activation_epoch,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_checkpoint_with_activation_set(
        frozen_mask: Vec<bool>,
        reference: Vec<Vector3>,
        frozen_dof_count: usize,
        free_dof_count: usize,
        constraint_activation_epochs: BTreeMap<String, u64>,
        active_constraint_ids: BTreeSet<String>,
        resolved_constraint_set_revision: u64,
    ) -> Result<Self> {
        if resolved_constraint_set_revision == 0
            || constraint_activation_epochs
                .values()
                .any(|epoch| *epoch == 0)
            || active_constraint_ids
                .iter()
                .any(|id| !constraint_activation_epochs.contains_key(id))
        {
            return Err(EngineError::new(
                "frozen_spins_checkpoint_activation_set_invalid",
            ));
        }
        let activation_epoch = active_constraint_ids
            .iter()
            .filter_map(|id| constraint_activation_epochs.get(id).copied())
            .max()
            .unwrap_or(1);
        let mut state = Self::from_checkpoint(
            frozen_mask,
            reference,
            frozen_dof_count,
            free_dof_count,
            activation_epoch,
        )?;
        state.constraint_activation_epochs = constraint_activation_epochs;
        state.active_constraint_ids = active_constraint_ids;
        state.resolved_constraint_set_revision = resolved_constraint_set_revision;
        Ok(state)
    }

    pub fn mask_final_rhs(&self, rhs: &mut [Vector3]) {
        for (value, frozen) in rhs.iter_mut().zip(&self.frozen_mask) {
            if *frozen {
                *value = [0.0; 3];
            }
        }
    }

    pub fn mask_final_rhs_soa(&self, rhs: &mut VectorFieldSoA) {
        debug_assert_eq!(rhs.len(), self.frozen_mask.len());
        for (index, frozen) in self.frozen_mask.iter().enumerate() {
            if *frozen {
                rhs.x[index] = 0.0;
                rhs.y[index] = 0.0;
                rhs.z[index] = 0.0;
            }
        }
    }

    pub fn restore_reference(&self, candidate: &mut [Vector3]) {
        for ((value, reference), frozen) in candidate
            .iter_mut()
            .zip(&self.reference)
            .zip(&self.frozen_mask)
        {
            if *frozen {
                *value = *reference;
            }
        }
    }

    /// Return whether the dense degree of freedom is constrained by this state.
    pub fn is_frozen(&self, index: usize) -> bool {
        self.frozen_mask.get(index).copied().unwrap_or(false)
    }

    /// Number of dense degrees of freedom covered by the captured state.
    pub fn len(&self) -> usize {
        self.frozen_mask.len()
    }

    /// Dense mask captured at activation, for checkpoint serialization and
    /// backend payload materialization.
    pub fn mask(&self) -> &[bool] {
        &self.frozen_mask
    }

    /// Reference magnetization captured at activation, for checkpoint
    /// serialization and exact restart.
    pub fn reference(&self) -> &[Vector3] {
        &self.reference
    }

    pub fn activation_epoch(&self) -> u64 {
        self.activation_epoch
    }

    pub fn constraint_activation_epochs(&self) -> &BTreeMap<String, u64> {
        &self.constraint_activation_epochs
    }

    pub fn active_constraint_ids(&self) -> &BTreeSet<String> {
        &self.active_constraint_ids
    }

    pub fn resolved_constraint_set_revision(&self) -> u64 {
        self.resolved_constraint_set_revision
    }

    pub fn max_norm_free(&self, values: &[Vector3]) -> f64 {
        values
            .iter()
            .zip(&self.frozen_mask)
            .filter(|(_, frozen)| !**frozen)
            .map(|(value, _)| crate::vector::norm(*value))
            .fold(0.0, f64::max)
    }

    pub fn max_norm_all(&self, values: &[Vector3]) -> f64 {
        values
            .iter()
            .map(|value| crate::vector::norm(*value))
            .fold(0.0, f64::max)
    }

    /// Maximum equilibrium torque over the free degrees of freedom only.
    pub fn max_cross_norm_free(&self, magnetization: &[Vector3], field: &[Vector3]) -> f64 {
        magnetization
            .iter()
            .zip(field)
            .zip(&self.frozen_mask)
            .filter(|(_, frozen)| !**frozen)
            .map(|((m, h), _)| crate::vector::norm(crate::vector::cross(*m, *h)))
            .fold(0.0, f64::max)
    }

    pub fn same_mask(&self, other: &Self) -> bool {
        self.frozen_mask == other.frozen_mask
    }

    pub fn frozen_dof_count(&self) -> usize {
        self.frozen_dof_count
    }

    pub fn free_dof_count(&self) -> usize {
        self.free_dof_count
    }

    pub fn all_active_dofs_frozen(&self) -> bool {
        self.frozen_dof_count > 0 && self.free_dof_count == 0
    }

    pub fn max_reference_drift(&self, state: &[Vector3]) -> f64 {
        state
            .iter()
            .zip(&self.reference)
            .zip(&self.frozen_mask)
            .filter(|(_, frozen)| **frozen)
            .map(|((value, reference), _)| {
                crate::vector::norm([
                    value[0] - reference[0],
                    value[1] - reference[1],
                    value[2] - reference[2],
                ])
            })
            .fold(0.0, f64::max)
    }

    /// Maximum representational distance from the captured reference over
    /// frozen components. A valid hard-restore acceptance gate requires zero.
    pub fn max_reference_ulp_drift(&self, state: &[Vector3]) -> u64 {
        fn ordered(bits: u64) -> u64 {
            if bits & (1_u64 << 63) == 0 {
                bits | (1_u64 << 63)
            } else {
                !bits
            }
        }

        state
            .iter()
            .zip(&self.reference)
            .zip(&self.frozen_mask)
            .filter(|(_, frozen)| **frozen)
            .flat_map(|((value, reference), _)| value.iter().zip(reference))
            .map(|(value, reference)| {
                ordered(value.to_bits()).abs_diff(ordered(reference.to_bits()))
            })
            .max()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_restore_is_zero_ulp_and_metric_detects_one_ulp() {
        let frozen = FrozenSpinsState::from_checkpoint(
            vec![true, false],
            vec![[1.0, -0.0, 0.5], [0.0, 1.0, 0.0]],
            1,
            1,
            1,
        )
        .unwrap();
        let mut candidate = vec![
            [f64::from_bits(1.0_f64.to_bits() + 1), 0.0, 0.5],
            [0.0, 0.0, 1.0],
        ];
        assert_eq!(frozen.max_reference_ulp_drift(&candidate), 1);

        frozen.restore_reference(&mut candidate);
        assert_eq!(frozen.max_reference_ulp_drift(&candidate), 0);
        assert_eq!(
            candidate[0].map(f64::to_bits),
            [1.0_f64, -0.0, 0.5].map(f64::to_bits)
        );
    }
}
