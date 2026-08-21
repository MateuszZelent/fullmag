//! Runtime ownership for the resolved FDM frozen-spin constraint.

use crate::{EngineError, Result, Vector3};
use fullmag_ir::ResolvedFrozenSpinsPlanIR;

/// Dense reference-state constraint captured atomically at stage activation.
#[derive(Debug, Clone, PartialEq)]
pub struct FrozenSpinsState {
    frozen_mask: Vec<bool>,
    reference: Vec<Vector3>,
    frozen_dof_count: usize,
    free_dof_count: usize,
    activation_epoch: u64,
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
        })
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
        })
    }

    pub fn mask_final_rhs(&self, rhs: &mut [Vector3]) {
        for (value, frozen) in rhs.iter_mut().zip(&self.frozen_mask) {
            if *frozen {
                *value = [0.0; 3];
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
}
