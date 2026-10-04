use crate::project::{
    DefinitionRevision, MigrationReport, ProjectEnvelope, ProjectId, ProjectSource, ProjectTarget,
};
use std::error::Error;

/// The receipt explicitly reports what the repository can guarantee.  The
/// application layer never upgrades `MemoryOnly` or `Unspecified` to durable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DurabilityGuarantee {
    Unspecified,
    MemoryOnly,
    FilesystemSynced {
        data_file_synced: bool,
        parent_directory_synced: bool,
        power_loss_qualified: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RepositoryOpenResult {
    pub envelope: ProjectEnvelope,
    pub source: ProjectSource,
    pub source_hash: Option<String>,
    pub target: Option<ProjectTarget>,
    pub migration: MigrationReport,
    pub read_only_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RepositoryCommitRequest {
    pub envelope: ProjectEnvelope,
    pub target: ProjectTarget,
    /// `Some` means update this exact existing project at `target`; the
    /// adapter must match both this id and `expected_revision`. `None` is a
    /// create-only publication and must not overwrite an existing target.
    pub expected_project_id: Option<ProjectId>,
    pub expected_revision: Option<DefinitionRevision>,
    pub client_intent_id: Option<String>,
    pub save_as: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RepositoryCommitResult {
    pub project_id: ProjectId,
    pub revision: DefinitionRevision,
    pub target: ProjectTarget,
    pub source_hash: Option<String>,
    pub durability: DurabilityGuarantee,
}

pub trait ProjectRepository: Send + Sync {
    type Error: Error + Send + Sync + 'static;

    /// Read, validate, and migrate a project without mutating the source.
    fn open(&self, source: ProjectSource) -> Result<RepositoryOpenResult, Self::Error>;

    /// Publish a candidate envelope.  The adapter owns staging, native
    /// writer ownership, archive format, and filesystem durability.
    fn commit(
        &self,
        request: RepositoryCommitRequest,
    ) -> Result<RepositoryCommitResult, Self::Error>;
}
