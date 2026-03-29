//! Unified interactive runtime for persistent backend sessions.
//!
//! This module provides:
//! - [`InteractiveBackend`] — trait abstracting FDM/FEM backends for interactive use
//! - [`InteractiveRuntime`] — facade owning a backend + display state + revision tracking
//! - [`DisplaySelection`] / [`DisplayPayload`] — typed display model
//! - [`LiveControlCommand`] — typed control commands replacing string-based `kind`

pub mod backend;
pub mod commands;
pub mod display;
pub mod runtime;

pub use backend::BackendGeometry;
pub(crate) use backend::InteractiveBackend;
pub use commands::LiveControlCommand;
pub use display::{DisplayKind, DisplayPayload, DisplaySelection};
pub use runtime::InteractiveRuntime;
