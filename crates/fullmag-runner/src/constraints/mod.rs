//! Durable constraint state shared by runner lanes.
//!
//! Constraint selectors are evaluated during planning/activation. Restart
//! payloads in this module deliberately carry the resolved dense state so a
//! restart never re-evaluates a state-dependent selector against a different
//! magnetization or topology.

mod activation;
mod checkpoint;

pub use activation::{
    FrozenOutputLifecycleV1, FrozenStageContextV1, FrozenStageEntryKind, FrozenSpinsActivation, FrozenSpinsActivationSet, FrozenSpinsActivationSnapshot,
    FrozenSpinsRuntimeStatus, FROZEN_SPINS_ACTIVATION_SCHEMA, FROZEN_SPINS_RUNTIME_STATUS_SCHEMA,
};
pub use checkpoint::{
    FrozenSpinsCheckpointError, FrozenSpinsCheckpointV1, FROZEN_SPINS_CHECKPOINT_SCHEMA,
};

#[cfg(feature = "cuda")]
pub(crate) use activation::require_cuda_frozen_reference;

pub(crate) struct FdmTerminalContext<'a> {
    pub frozen: &'a FrozenStageContextV1,
    pub source_frozen_plan: Option<&'a fullmag_ir::ResolvedFrozenSpinsPlanIR>,
    pub drain_writer: &'a mut (dyn FnMut() -> Result<(), crate::types::RunError> + Send),
}
