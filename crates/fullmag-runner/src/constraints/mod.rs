//! Durable constraint state shared by runner lanes.
//!
//! Constraint selectors are evaluated during planning/activation. Restart
//! payloads in this module deliberately carry the resolved dense state so a
//! restart never re-evaluates a state-dependent selector against a different
//! magnetization or topology.

mod activation;
mod checkpoint;

pub use activation::{
    FrozenSpinsActivation, FrozenSpinsActivationSet, FrozenSpinsActivationSnapshot,
    FrozenSpinsRuntimeStatus, FROZEN_SPINS_ACTIVATION_SCHEMA, FROZEN_SPINS_RUNTIME_STATUS_SCHEMA,
};
pub use checkpoint::{
    FrozenSpinsCheckpointError, FrozenSpinsCheckpointV1, FROZEN_SPINS_CHECKPOINT_SCHEMA,
};
