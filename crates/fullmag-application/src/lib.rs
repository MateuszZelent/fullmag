//! Application-level project lifecycle primitives.
//!
//! This crate deliberately has no HTTP, UI, solver, or filesystem dependency.
//! A repository adapter owns archive parsing and durable publication.  The
//! application layer owns the document lifecycle and its revision/dirty
//! policy, so every entry point can use the same Create/Open/Save/Save As/
//! Close semantics.

mod application;
mod file_repository;
mod project;
mod repository;

pub use application::{
    ActiveExecution, ActiveExecutionPolicy, ApplicationError, CloseRequest, CloseResult,
    CreateProjectRequest, DirtyClosePolicy, DocumentMode, DocumentView, OpenProjectResult,
    ProjectApplication, SaveAsProjectRequest, SaveProjectRequest, SaveReceipt,
};
pub use file_repository::{FileProjectRepository, FileRepositoryError};
pub use project::{
    DefinitionRevision, JsonEnvelopeError, MigrationReport, OpaqueAsset, OpaqueDocument,
    ProjectDefinition, ProjectDefinitionError, ProjectEnvelope, ProjectId, ProjectIdError,
    ProjectPathError, ProjectSource, ProjectTarget, RawJsonEnvelope, CURRENT_PROJECT_SCHEMA,
    CURRENT_SCENE_SCHEMA,
};
pub use repository::{
    DurabilityGuarantee, ProjectRepository, RepositoryCommitRequest, RepositoryCommitResult,
    RepositoryOpenResult,
};
