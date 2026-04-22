//! Unified interactive runtime for persistent backend sessions.
//!
//! This module provides:
//! - [`InteractiveBackend`] — trait abstracting FDM/FEM backends for interactive use
//! - [`InteractiveRuntime`] — facade owning a backend + display state + revision tracking
//! - [`DisplaySelection`] / [`DisplayPayload`] — typed display model
//! - [`LiveControlCommand`] — typed control commands replacing string-based `kind`

pub mod backend;
pub mod cache;
pub mod checkpoints;
pub mod commands;
pub mod display;
pub mod events;
pub mod runtime;

pub use backend::BackendGeometry;
pub(crate) use backend::InteractiveBackend;
pub(crate) use checkpoints::CheckpointContext;
pub use checkpoints::RunOutcome;
pub use commands::{
    parse_session_command, LiveControlCommand, RuntimeControlOutcome, SequenceStage,
};
pub use display::{
    DisplayFieldComponent, DisplayKind, DisplayPayload, DisplaySelection, DisplaySelectionState,
    DisplayViewMode,
};
pub use events::{
    CommandAckEvent, CommandCompletedEvent, CommandRejectedEvent, RuntimeEventEnvelope,
    RuntimeStatus, RuntimeStatusChangedEvent, StepDeltaEvent,
};
pub use runtime::InteractiveRuntime;
