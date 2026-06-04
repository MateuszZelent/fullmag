//! # fullmag-session
//!
//! Session persistence for the Fullmag micromagnetic simulation platform.
//!
//! This crate provides:
//! - **`types`** — Canonical data structures for session manifests, checkpoints,
//!   tensor descriptors, save profiles, and restore classes.
//! - **`cas`** — A content-addressed store (CAS) for deduplicating large binary
//!   objects (magnetization vectors, mesh data, field snapshots).
//! - **`store`** — The internal `SessionStore` backed by a directory tree,
//!   optimized for autosave, crash recovery, and incremental checkpoints.
//! - **`fms`** — The portable `.fms` file format (ZIP64-based archive) for
//!   user-facing Save / Open / Share workflows.
//! - **`capture`** — Checkpoint capture logic bridging the runner's live state
//!   to the serializable session format.

pub mod capture;
pub mod cas;
pub mod communication_policy;
pub mod fms;
pub mod store;
pub mod types;

// Re-export the most commonly used items at crate root.
pub use capture::{
    capture_checkpoint, determine_restore_class, CaptureRequest, CaptureResult,
    CheckpointSnapshotProvider,
};
pub use cas::{hex_sha256, CasStore};
pub use fms::{inspect_fms, pack_fms, unpack_fms, PackOptions};
pub use store::SessionStore;
pub use types::*;
