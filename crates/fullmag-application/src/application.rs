use crate::project::{
    DefinitionRevision, MigrationReport, ProjectEnvelope, ProjectId, ProjectSource, ProjectTarget,
    CURRENT_PROJECT_SCHEMA, CURRENT_SCENE_SCHEMA,
};
use crate::repository::{DurabilityGuarantee, ProjectRepository, RepositoryCommitRequest};
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DocumentMode {
    ReadWrite,
    ReadOnly { reason: String },
}

impl DocumentMode {
    pub fn is_writable(&self) -> bool {
        matches!(self, Self::ReadWrite)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveExecution {
    pub run_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentView {
    pub project_id: ProjectId,
    pub schema_version: String,
    pub revision: DefinitionRevision,
    pub persisted_revision: Option<DefinitionRevision>,
    pub dirty: bool,
    pub mode: DocumentMode,
    pub target: Option<ProjectTarget>,
    pub source_hash: Option<String>,
    pub migration: MigrationReport,
    pub active_execution: Option<ActiveExecution>,
}

#[derive(Clone, Debug)]
struct DocumentContext {
    envelope: ProjectEnvelope,
    target: Option<ProjectTarget>,
    source_hash: Option<String>,
    persisted_revision: Option<DefinitionRevision>,
    migration: MigrationReport,
    mode: DocumentMode,
    dirty: bool,
    active_execution: Option<ActiveExecution>,
}

impl DocumentContext {
    fn view(&self) -> DocumentView {
        DocumentView {
            project_id: self.envelope.definition.project_id.clone(),
            schema_version: self.envelope.definition.schema_version.clone(),
            revision: self.envelope.definition.revision,
            persisted_revision: self.persisted_revision,
            dirty: self.dirty,
            mode: self.mode.clone(),
            target: self.target.clone(),
            source_hash: self.source_hash.clone(),
            migration: self.migration.clone(),
            active_execution: self.active_execution.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CreateProjectRequest {
    pub name: String,
    pub project_id: Option<ProjectId>,
}

impl CreateProjectRequest {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            project_id: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SaveProjectRequest {
    pub target: Option<ProjectTarget>,
    /// Last persisted revision, distinct from the current edited draft revision.
    pub expected_revision: Option<DefinitionRevision>,
    pub client_intent_id: Option<String>,
}

impl Default for SaveProjectRequest {
    fn default() -> Self {
        Self {
            target: None,
            expected_revision: None,
            client_intent_id: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SaveAsProjectRequest {
    pub target: ProjectTarget,
    pub project_id: Option<ProjectId>,
    pub client_intent_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirtyClosePolicy {
    RequireSaved,
    Discard,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveExecutionPolicy {
    Refuse,
    KeepRunning,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CloseRequest {
    pub dirty: DirtyClosePolicy,
    pub active_execution: ActiveExecutionPolicy,
}

impl Default for CloseRequest {
    fn default() -> Self {
        Self {
            dirty: DirtyClosePolicy::RequireSaved,
            active_execution: ActiveExecutionPolicy::Refuse,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenProjectResult {
    pub view: DocumentView,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SaveReceipt {
    pub project_id: ProjectId,
    pub previous_project_id: Option<ProjectId>,
    pub revision: DefinitionRevision,
    pub target: ProjectTarget,
    pub source_hash: Option<String>,
    pub durability: DurabilityGuarantee,
    pub save_as: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseResult {
    pub project_id: ProjectId,
    pub discarded_dirty_draft: bool,
    pub runtime_left_untouched: bool,
}

pub struct ProjectApplication<R> {
    repository: R,
    current: Option<DocumentContext>,
}

impl<R> ProjectApplication<R>
where
    R: ProjectRepository,
{
    pub fn new(repository: R) -> Self {
        Self {
            repository,
            current: None,
        }
    }

    pub fn repository(&self) -> &R {
        &self.repository
    }

    pub fn current(&self) -> Option<DocumentView> {
        self.current.as_ref().map(DocumentContext::view)
    }

    /// Returns the current document payload for resource adapters and views.
    ///
    /// The returned envelope is immutable; mutations must go through the
    /// revision-checked draft methods on this application.
    pub fn current_document(&self) -> Option<&ProjectEnvelope> {
        self.current.as_ref().map(|context| &context.envelope)
    }

    pub fn create(
        &mut self,
        request: CreateProjectRequest,
    ) -> Result<DocumentView, ApplicationError<R::Error>> {
        self.ensure_no_open_document()?;
        let project_id = request.project_id.unwrap_or_default();
        let envelope = ProjectEnvelope::blank(project_id, request.name)
            .map_err(ApplicationError::invalid_definition)?;
        let context = DocumentContext {
            envelope,
            target: None,
            source_hash: None,
            persisted_revision: None,
            migration: MigrationReport::current(),
            mode: DocumentMode::ReadWrite,
            dirty: true,
            active_execution: None,
        };
        let view = context.view();
        self.current = Some(context);
        Ok(view)
    }

    pub fn open(
        &mut self,
        source: ProjectSource,
    ) -> Result<OpenProjectResult, ApplicationError<R::Error>> {
        self.ensure_no_open_document()?;
        let opened = self
            .repository
            .open(source)
            .map_err(ApplicationError::repository)?;
        let mode = if let Some(reason) = opened.read_only_reason {
            DocumentMode::ReadOnly { reason }
        } else if !opened.migration.can_write
            || opened.envelope.definition.schema_version != CURRENT_PROJECT_SCHEMA
            || opened
                .envelope
                .definition
                .scene
                .value()
                .get("version")
                .and_then(|value| value.as_str())
                != Some(CURRENT_SCENE_SCHEMA)
        {
            DocumentMode::ReadOnly {
                reason: opened
                    .migration
                    .warnings
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "project schema is not writable".into()),
            }
        } else {
            DocumentMode::ReadWrite
        };
        let persisted_revision = Some(opened.envelope.definition.revision);
        let context = DocumentContext {
            envelope: opened.envelope,
            target: opened.target,
            source_hash: opened.source_hash,
            persisted_revision,
            migration: opened.migration,
            mode,
            dirty: false,
            active_execution: None,
        };
        let view = context.view();
        self.current = Some(context);
        Ok(OpenProjectResult { view })
    }

    pub fn replace_draft(
        &mut self,
        mut draft: ProjectEnvelope,
        expected_revision: DefinitionRevision,
    ) -> Result<DocumentView, ApplicationError<R::Error>> {
        let context = self
            .current
            .as_mut()
            .ok_or(ApplicationError::NoOpenDocument)?;
        ensure_writable::<R>(context)?;
        if context.envelope.definition.revision != expected_revision {
            return Err(ApplicationError::RevisionConflict {
                expected: Some(expected_revision),
                actual: Some(context.envelope.definition.revision),
            });
        }
        if draft.definition.project_id != context.envelope.definition.project_id {
            return Err(ApplicationError::ProjectIdMismatch);
        }
        draft.definition.revision = context
            .envelope
            .definition
            .revision
            .checked_add(1)
            .ok_or_else(|| ApplicationError::invalid_definition("definition revision overflow"))?;
        draft
            .rewrite_known_fields()
            .map_err(ApplicationError::invalid_definition)?;
        context.envelope = draft;
        context.dirty = true;
        Ok(context.view())
    }

    pub fn mark_dirty(&mut self) -> Result<DocumentView, ApplicationError<R::Error>> {
        let context = self
            .current
            .as_mut()
            .ok_or(ApplicationError::NoOpenDocument)?;
        ensure_writable::<R>(context)?;
        let mut candidate = context.envelope.clone();
        candidate.definition.revision = candidate
            .definition
            .revision
            .checked_add(1)
            .ok_or_else(|| ApplicationError::invalid_definition("definition revision overflow"))?;
        candidate
            .rewrite_known_fields()
            .map_err(ApplicationError::invalid_definition)?;
        context.envelope = candidate;
        context.dirty = true;
        Ok(context.view())
    }

    pub fn set_active_execution(
        &mut self,
        run_id: impl Into<String>,
    ) -> Result<DocumentView, ApplicationError<R::Error>> {
        let run_id = run_id.into();
        if run_id.trim().is_empty() {
            return Err(ApplicationError::invalid_request(
                "run id must not be empty",
            ));
        }
        let context = self
            .current
            .as_mut()
            .ok_or(ApplicationError::NoOpenDocument)?;
        if let Some(active) = &context.active_execution {
            if active.run_id != run_id {
                return Err(ApplicationError::ActiveExecutionRequiresAction {
                    run_id: active.run_id.clone(),
                });
            }
        }
        context.active_execution = Some(ActiveExecution { run_id });
        Ok(context.view())
    }

    /// Clear only the run identified by a terminal notification. A delayed
    /// notification from another execution cannot clear the current marker.
    pub fn finish_execution(
        &mut self,
        expected_run_id: &str,
    ) -> Result<DocumentView, ApplicationError<R::Error>> {
        let context = self
            .current
            .as_mut()
            .ok_or(ApplicationError::NoOpenDocument)?;
        if context
            .active_execution
            .as_ref()
            .map(|execution| execution.run_id.as_str())
            != Some(expected_run_id)
        {
            return Err(ApplicationError::invalid_request(
                "execution identity mismatch",
            ));
        }
        context.active_execution = None;
        Ok(context.view())
    }

    pub fn save(
        &mut self,
        request: SaveProjectRequest,
    ) -> Result<SaveReceipt, ApplicationError<R::Error>> {
        let (envelope, current_target, persisted_revision) = {
            let context = self
                .current
                .as_ref()
                .ok_or(ApplicationError::NoOpenDocument)?;
            ensure_writable::<R>(context)?;
            if let Some(expected) = request.expected_revision {
                if Some(expected) != context.persisted_revision {
                    return Err(ApplicationError::RevisionConflict {
                        expected: Some(expected),
                        actual: context.persisted_revision,
                    });
                }
            }
            context
                .envelope
                .validate_for_save()
                .map_err(ApplicationError::invalid_definition)?;
            (
                context.envelope.clone(),
                context.target.clone(),
                context.persisted_revision,
            )
        };
        if let (Some(current), Some(requested)) = (&current_target, &request.target) {
            if current != requested {
                return Err(ApplicationError::invalid_request(
                    "Save cannot change an existing project target; use Save As",
                ));
            }
        }
        let target = request
            .target
            .or(current_target)
            .ok_or(ApplicationError::SaveTargetRequired)?;
        target
            .validate()
            .map_err(|error| ApplicationError::invalid_definition(error.to_string()))?;
        let expected_project_id = envelope.definition.project_id.clone();
        let expected_revision = envelope.definition.revision;
        let expected_target = target.clone();
        let result = self
            .repository
            .commit(RepositoryCommitRequest {
                envelope,
                target,
                expected_project_id: persisted_revision.map(|_| expected_project_id.clone()),
                expected_revision: persisted_revision,
                client_intent_id: request.client_intent_id,
                save_as: false,
            })
            .map_err(ApplicationError::repository)?;
        self.apply_commit_result(
            result,
            expected_project_id,
            expected_revision,
            expected_target,
            None,
        )
    }

    /// Publishes a document that was opened from bytes to a new filesystem
    /// target.  A detached document has no existing target to compare against,
    /// so this operation is deliberately create-only and never overwrites an
    /// existing path.  Host adapters use it for the first durable Save of a
    /// browser-created project; subsequent writes use [`Self::save`] after the
    /// target has been attached to the application context.
    pub fn save_detached(
        &mut self,
        target: ProjectTarget,
        client_intent_id: Option<String>,
    ) -> Result<SaveReceipt, ApplicationError<R::Error>> {
        let (envelope, current_target) = {
            let context = self
                .current
                .as_ref()
                .ok_or(ApplicationError::NoOpenDocument)?;
            ensure_writable::<R>(context)?;
            context
                .envelope
                .validate_for_save()
                .map_err(ApplicationError::invalid_definition)?;
            (context.envelope.clone(), context.target.clone())
        };
        if current_target.is_some() {
            return Err(ApplicationError::invalid_request(
                "detached Save requires a document without an existing target",
            ));
        }
        target
            .validate()
            .map_err(|error| ApplicationError::invalid_definition(error.to_string()))?;
        let expected_project_id = envelope.definition.project_id.clone();
        let expected_revision = envelope.definition.revision;
        let expected_target = target.clone();
        let result = self
            .repository
            .commit(RepositoryCommitRequest {
                envelope,
                target,
                expected_project_id: None,
                expected_revision: None,
                client_intent_id,
                save_as: false,
            })
            .map_err(ApplicationError::repository)?;
        self.apply_commit_result(
            result,
            expected_project_id,
            expected_revision,
            expected_target,
            None,
        )
    }

    pub fn save_as(
        &mut self,
        request: SaveAsProjectRequest,
    ) -> Result<SaveReceipt, ApplicationError<R::Error>> {
        let (envelope, previous_project_id) = {
            let context = self
                .current
                .as_ref()
                .ok_or(ApplicationError::NoOpenDocument)?;
            ensure_writable::<R>(context)?;
            if let Some(execution) = &context.active_execution {
                return Err(ApplicationError::ActiveExecutionRequiresAction {
                    run_id: execution.run_id.clone(),
                });
            }
            context
                .envelope
                .validate_for_save()
                .map_err(ApplicationError::invalid_definition)?;
            if context.target.as_ref() == Some(&request.target) {
                return Err(ApplicationError::invalid_request(
                    "Save As target must differ from the current project target",
                ));
            }
            (
                context.envelope.clone(),
                context.envelope.definition.project_id.clone(),
            )
        };
        let new_project_id = request.project_id.unwrap_or_default();
        if new_project_id == previous_project_id {
            return Err(ApplicationError::invalid_request(
                "Save As requires a new project id",
            ));
        }
        let envelope = envelope
            .for_save_as(new_project_id)
            .map_err(ApplicationError::invalid_definition)?;
        request
            .target
            .validate()
            .map_err(|error| ApplicationError::invalid_definition(error.to_string()))?;
        let expected_project_id = envelope.definition.project_id.clone();
        let expected_revision = envelope.definition.revision;
        let expected_target = request.target.clone();
        let result = self
            .repository
            .commit(RepositoryCommitRequest {
                envelope,
                target: expected_target.clone(),
                expected_project_id: None,
                expected_revision: None,
                client_intent_id: request.client_intent_id,
                save_as: true,
            })
            .map_err(ApplicationError::repository)?;
        self.apply_commit_result(
            result,
            expected_project_id,
            expected_revision,
            expected_target,
            Some(previous_project_id),
        )
    }

    pub fn close(
        &mut self,
        request: CloseRequest,
    ) -> Result<CloseResult, ApplicationError<R::Error>> {
        let context = self
            .current
            .as_ref()
            .ok_or(ApplicationError::NoOpenDocument)?;
        if context.dirty && matches!(request.dirty, DirtyClosePolicy::RequireSaved) {
            return Err(ApplicationError::UnsavedChanges {
                project_id: context.envelope.definition.project_id.clone(),
            });
        }
        if let Some(execution) = &context.active_execution {
            if matches!(request.active_execution, ActiveExecutionPolicy::Refuse) {
                return Err(ApplicationError::ActiveExecutionRequiresAction {
                    run_id: execution.run_id.clone(),
                });
            }
        }
        let project_id = context.envelope.definition.project_id.clone();
        let discarded_dirty_draft = context.dirty;
        let runtime_left_untouched = context.active_execution.is_some();
        self.current = None;
        Ok(CloseResult {
            project_id,
            discarded_dirty_draft,
            runtime_left_untouched,
        })
    }

    fn apply_commit_result(
        &mut self,
        result: crate::repository::RepositoryCommitResult,
        expected_project_id: ProjectId,
        expected_revision: DefinitionRevision,
        expected_target: ProjectTarget,
        previous_project_id: Option<ProjectId>,
    ) -> Result<SaveReceipt, ApplicationError<R::Error>> {
        let context = self
            .current
            .as_mut()
            .ok_or(ApplicationError::NoOpenDocument)?;
        let expected_current_project_id =
            previous_project_id.as_ref().unwrap_or(&expected_project_id);
        if &context.envelope.definition.project_id != expected_current_project_id {
            return Err(ApplicationError::ProjectIdMismatch);
        }
        if result.project_id != expected_project_id
            || result.revision != expected_revision
            || result.target != expected_target
        {
            return Err(ApplicationError::RepositoryContract(
                "repository commit result does not match the requested project, revision, or target"
                    .into(),
            ));
        }
        let save_as = previous_project_id.is_some();
        context.envelope.definition.project_id = result.project_id.clone();
        context.envelope.definition.revision = result.revision;
        context
            .envelope
            .rewrite_known_fields()
            .map_err(ApplicationError::invalid_definition)?;
        context.target = Some(result.target.clone());
        context.source_hash = result.source_hash.clone();
        context.persisted_revision = Some(result.revision);
        context.dirty = false;
        context.mode = DocumentMode::ReadWrite;
        Ok(SaveReceipt {
            project_id: result.project_id,
            previous_project_id,
            revision: result.revision,
            target: result.target,
            source_hash: result.source_hash,
            durability: result.durability,
            save_as,
        })
    }

    fn ensure_no_open_document(&self) -> Result<(), ApplicationError<R::Error>> {
        if self.current.is_some() {
            return Err(ApplicationError::DocumentAlreadyOpen);
        }
        Ok(())
    }
}

fn ensure_writable<R>(context: &DocumentContext) -> Result<(), ApplicationError<R::Error>>
where
    R: ProjectRepository,
{
    if !context.mode.is_writable() || !context.migration.can_write {
        let reason = match &context.mode {
            DocumentMode::ReadOnly { reason } => reason.clone(),
            DocumentMode::ReadWrite => "migration marked project read-only".into(),
        };
        return Err(ApplicationError::ReadOnly {
            project_id: context.envelope.definition.project_id.clone(),
            reason,
        });
    }
    Ok(())
}

#[derive(Debug)]
pub enum ApplicationError<E> {
    Repository(E),
    RepositoryContract(String),
    NoOpenDocument,
    DocumentAlreadyOpen,
    UnsavedChanges {
        project_id: ProjectId,
    },
    ActiveExecutionRequiresAction {
        run_id: String,
    },
    ReadOnly {
        project_id: ProjectId,
        reason: String,
    },
    SaveTargetRequired,
    RevisionConflict {
        expected: Option<DefinitionRevision>,
        actual: Option<DefinitionRevision>,
    },
    ProjectIdMismatch,
    InvalidRequest(String),
    InvalidDefinition(String),
}

impl<E> ApplicationError<E> {
    fn repository(error: E) -> Self {
        Self::Repository(error)
    }

    fn invalid_request(message: impl Into<String>) -> Self {
        Self::InvalidRequest(message.into())
    }

    fn invalid_definition(error: impl fmt::Display) -> Self {
        Self::InvalidDefinition(error.to_string())
    }
}

impl<E: fmt::Display> fmt::Display for ApplicationError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Repository(error) => write!(formatter, "repository error: {error}"),
            Self::RepositoryContract(error) => {
                write!(formatter, "repository contract error: {error}")
            }
            Self::NoOpenDocument => formatter.write_str("no project document is open"),
            Self::DocumentAlreadyOpen => formatter.write_str("a project document is already open"),
            Self::UnsavedChanges { project_id } => {
                write!(
                    formatter,
                    "project {} has unsaved changes",
                    project_id.as_str()
                )
            }
            Self::ActiveExecutionRequiresAction { run_id } => {
                write!(
                    formatter,
                    "active execution `{run_id}` requires an explicit lifecycle decision"
                )
            }
            Self::ReadOnly { project_id, reason } => {
                write!(
                    formatter,
                    "project {} is read-only: {reason}",
                    project_id.as_str()
                )
            }
            Self::SaveTargetRequired => formatter.write_str("a save target is required"),
            Self::RevisionConflict { expected, actual } => {
                write!(
                    formatter,
                    "revision conflict: expected {expected:?}, actual {actual:?}"
                )
            }
            Self::ProjectIdMismatch => {
                formatter.write_str("draft project id does not match the open document")
            }
            Self::InvalidRequest(error) | Self::InvalidDefinition(error) => {
                formatter.write_str(error)
            }
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for ApplicationError<E> {}
