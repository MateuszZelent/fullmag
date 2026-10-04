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

mod archive_capacity;
mod archive_document;
mod archive_source;
pub mod capture;
pub mod cas;
pub mod communication_policy;
pub mod dataset_slice_adapter;
mod durability;
mod development_owner;
pub mod development_restart_transport;
pub mod fms;
pub mod mesh_operation;
pub mod materialized_dataset;
pub mod reachability;
pub mod repository_path;
pub mod runtime_service;
pub mod runtime_service_startup;
pub mod solution_set_catalog;
pub mod solution_field_geometry;
pub mod solution_scalar_source;
pub mod solution_tensor_field;
pub mod solution_tensor_source;
pub mod store;
pub mod types;
mod worker_inbox;
mod writer;
pub use worker_inbox::FmsWorkerInboxRecord;
pub use development_owner::publish_managed_owner_record;
pub use development_restart_transport::{
    publish_request, publish_result, read_pending_request, read_request_for_status, read_result,
    RestartRequest, RestartResult, RestartResultState,
};

// Re-export the most commonly used items at crate root.
pub use capture::{
    capture_checkpoint, determine_restore_class, CaptureRequest, CaptureResult,
    CheckpointSnapshotProvider,
};
pub use archive_capacity::ArchiveCapacityUnavailable;
pub use cas::{hex_sha256, CasStore};
pub use durability::{
    durability_capability, publish_directory, DirectorySyncCapability, DurabilityCapability, PowerLossCapability,
    PublicationUncertain, WriterReleaseUnconfirmed,
};
pub use fms::{
    inspect_fms, pack_fms, pack_fms_file, preflight_fms, preflight_fms_staged,
    unpack_fms, unpack_fms_for_visualization, unpack_fms_staged, FmsPreflight,
    FmsStagedPreflight, PackOptions,
};
pub use store::{GcPlan, RunBacklogFull, SessionStore};
pub use types::*;
pub use writer::{StoreWriterBusy, WriteTransaction};
