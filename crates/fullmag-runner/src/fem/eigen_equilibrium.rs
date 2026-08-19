//! Legacy module boundary for FEM eigen equilibrium materialization.
//!
//! The production implementation lives in `crate::fem_eigen`, where it can
//! consume the immutable accepted-relaxation handoff or a certified
//! `equilibrium_artifact.v7`.  Pre-eigen relaxation is deliberately forbidden:
//! it would apply a second stopping policy after the user-authored Relax stage.

use fullmag_engine::fem::FemLlgProblem;
use fullmag_engine::{EffectiveFieldObservables, Vector3};
use fullmag_ir::FemEigenPlanIR;

use crate::types::RunError;

#[allow(dead_code)]
pub(crate) fn materialize_equilibrium(
    _plan: &FemEigenPlanIR,
    _initial_magnetization: &[Vector3],
) -> Result<(FemLlgProblem, Vec<Vector3>, u64, EffectiveFieldObservables), RunError> {
    Err(RunError {
        message: "certified FEM eigen equilibrium must be materialized through crate::fem_eigen; internal pre-eigen relaxation is not supported"
            .to_string(),
    })
}
