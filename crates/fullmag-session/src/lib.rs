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

pub mod accepted_provenance;
mod archive_capacity;
mod archive_document;
mod archive_source;
mod docker_desktop_storage;
#[doc(hidden)]
pub use docker_desktop_storage::initialize_attested_docker_accepted_store;
pub mod capture;
pub mod cas;
pub mod communication_policy;
pub mod compute_node_policy;
pub mod compute_node_snapshot;
pub mod dataset_slice_adapter;
mod development_owner;
pub mod development_restart_transport;
mod durability;
pub mod execution_profiles;
pub mod fms;
pub mod frequency_domain_artifact_generation;
pub mod host_resource_ledger;
pub mod materialized_dataset;
pub mod mesh_operation;
pub mod reachability;
pub mod repository_path;
pub mod runtime_service;
pub mod runtime_service_host;
pub mod runtime_service_startup;
pub mod solution_field_geometry;
pub mod solution_scalar_source;
pub mod solution_set_catalog;
pub mod solution_tensor_field;
pub mod solution_tensor_source;
pub mod store;
pub mod task_cancellation;
mod typed_documents;
pub mod types;
mod worker_inbox;
mod writer;
pub use development_owner::publish_managed_owner_record;
pub use development_restart_transport::{
    RestartRequest, RestartResult, RestartResultState, publish_request, publish_result,
    read_pending_request, read_request_for_status, read_result,
};
pub use worker_inbox::FmsWorkerInboxRecord;

// Re-export the most commonly used items at crate root.
pub use archive_capacity::ArchiveCapacityUnavailable;
pub use capture::{
    CaptureRequest, CaptureResult, CheckpointSnapshotProvider, capture_checkpoint,
    determine_restore_class,
};
pub use cas::{CasStore, hex_sha256};
pub use durability::{
    DirectorySyncCapability, DurabilityCapability, PowerLossCapability, PublicationUncertain,
    WriterReleaseUnconfirmed, durability_capability, publish_directory,
};
pub use fms::{
    FmsPreflight, FmsStagedPreflight, PackOptions, inspect_fms, pack_fms, pack_fms_file,
    pack_fms_with_accepted_provenance, preflight_fms, preflight_fms_staged, unpack_fms,
    unpack_fms_for_visualization, unpack_fms_staged, unpack_fms_staged_readonly,
};
pub use store::{
    ACCEPTED_RUN_START_POLICY_KEY, AcceptedRunStartRelease, CheckpointStillReferenced, GcPlan,
    RunBacklogFull, SessionStore,
};
pub use task_cancellation::{
    FMS_TASK_CANCELLATION_INTENT_SCHEMA, FmsTaskCancellationIntent,
    TaskCancellationIntentCommitDisposition, TaskCancellationIntentConflict,
};
pub use types::*;
pub use writer::{StoreWriterBusy, WriteTransaction};
