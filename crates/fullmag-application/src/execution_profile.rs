//! Compatibility re-exports for pure execution-profile materialization.
//!
//! The implementation lives in `fullmag-ir`; application binding, capability
//! checks, and runtime authority remain above the shared IR contract.

pub use fullmag_ir::execution_profile_materialization::{
    materialize_execution_request, materialize_referenced_execution,
    validate_execution_materialization,
};

#[cfg(test)]
use fullmag_ir::{
    ExecutionDevice, ExecutionFieldOriginIR, ExecutionOriginKindIR, ExecutionProfileIR,
    ExecutionRequestLayerIR, ExecutionRequestPatchIR, FieldPatch,
};

#[cfg(test)]
#[path = "execution_profile_reference_tests.rs"]
mod reference_tests;
