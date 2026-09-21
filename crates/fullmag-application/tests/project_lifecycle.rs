use fullmag_application::{
    ActiveExecutionPolicy, ApplicationError, CloseRequest, CreateProjectRequest, DirtyClosePolicy,
    DocumentMode, DurabilityGuarantee, MigrationReport, OpaqueAsset, ProjectApplication,
    ProjectEnvelope, ProjectId, ProjectRepository, ProjectSource, ProjectTarget, RawJsonEnvelope,
    RepositoryCommitRequest, RepositoryCommitResult, RepositoryOpenResult, SaveAsProjectRequest,
    SaveProjectRequest,
};
use serde_json::json;
use std::{
    collections::HashMap,
    fmt,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Clone, PartialEq, Eq)]
struct FakeError(String);

impl fmt::Display for FakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for FakeError {}

#[derive(Default)]
struct FakeRepository {
    projects: Mutex<HashMap<PathBuf, ProjectEnvelope>>,
    open_records: Mutex<HashMap<PathBuf, RepositoryOpenResult>>,
    commits: Mutex<Vec<RepositoryCommitRequest>>,
}

impl FakeRepository {
    fn seed(&self, path: impl Into<PathBuf>, envelope: ProjectEnvelope) {
        self.projects.lock().unwrap().insert(path.into(), envelope);
    }

    fn seed_open_record(&self, path: impl Into<PathBuf>, record: RepositoryOpenResult) {
        self.open_records
            .lock()
            .unwrap()
            .insert(path.into(), record);
    }

    fn stored(&self, path: impl AsRef<Path>) -> ProjectEnvelope {
        self.projects
            .lock()
            .unwrap()
            .get(path.as_ref())
            .cloned()
            .expect("fake repository should contain the project")
    }

    fn commit_count(&self) -> usize {
        self.commits.lock().unwrap().len()
    }
}

impl ProjectRepository for FakeRepository {
    type Error = FakeError;

    fn open(&self, source: ProjectSource) -> Result<RepositoryOpenResult, Self::Error> {
        let path = match &source {
            ProjectSource::Path(path) => path,
            ProjectSource::Bytes { .. } => {
                return Err(FakeError("byte source not configured in fake".into()))
            }
        };
        if let Some(record) = self.open_records.lock().unwrap().get(path).cloned() {
            return Ok(record);
        }
        let envelope = self
            .projects
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| FakeError(format!("missing fake project {}", path.display())))?;
        Ok(RepositoryOpenResult {
            envelope,
            source: source.clone(),
            source_hash: Some(format!("fake:{}", path.display())),
            target: Some(ProjectTarget::Path(path.clone())),
            migration: MigrationReport::current(),
            read_only_reason: None,
        })
    }

    fn commit(
        &self,
        request: RepositoryCommitRequest,
    ) -> Result<RepositoryCommitResult, Self::Error> {
        let path = request.target.path().clone();
        let mut projects = self.projects.lock().unwrap();
        let previous = projects
            .get(&path)
            .map(|project| project.definition.revision);
        let previous_id = projects
            .get(&path)
            .map(|project| &project.definition.project_id);
        if previous_id != request.expected_project_id.as_ref() {
            return Err(FakeError("project identity conflict".into()));
        }
        if previous != request.expected_revision {
            return Err(FakeError(format!(
                "revision conflict: expected {:?}, actual {:?}",
                request.expected_revision, previous
            )));
        }
        let project_id = request.envelope.definition.project_id.clone();
        let revision = request.envelope.definition.revision;
        projects.insert(path.clone(), request.envelope.clone());
        self.commits.lock().unwrap().push(request);
        Ok(RepositoryCommitResult {
            project_id,
            revision,
            target: ProjectTarget::Path(path),
            source_hash: Some("fake:committed".into()),
            durability: DurabilityGuarantee::MemoryOnly,
        })
    }
}

fn target(path: &str) -> ProjectTarget {
    ProjectTarget::Path(PathBuf::from(path))
}

#[test]
fn create_save_close_open_roundtrips_without_runtime() {
    let repository = FakeRepository::default();
    let mut application = ProjectApplication::new(repository);
    let created = application
        .create(CreateProjectRequest::new("Draft"))
        .unwrap();
    assert!(created.dirty);
    assert_eq!(created.schema_version, "fullmag.project.v1");
    assert_eq!(created.revision, 0);

    let receipt = application
        .save(SaveProjectRequest {
            target: Some(target("draft.fms")),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(receipt.durability, DurabilityGuarantee::MemoryOnly);
    assert_eq!(application.repository().commit_count(), 1);
    application.close(CloseRequest::default()).unwrap();

    let opened = application
        .open(ProjectSource::Path(PathBuf::from("draft.fms")))
        .unwrap();
    assert_eq!(opened.view.project_id, receipt.project_id);
    assert!(!opened.view.dirty);
    assert!(opened.view.active_execution.is_none());
}

#[test]
fn detached_save_publishes_bytes_to_a_new_target_without_overwrite() {
    let repository = FakeRepository::default();
    let mut application = ProjectApplication::new(repository);
    let created = application
        .create(CreateProjectRequest::new("Detached"))
        .unwrap();

    let receipt = application
        .save_detached(target("detached.fms"), Some("host-save-1".into()))
        .unwrap();

    assert_eq!(receipt.project_id, created.project_id);
    assert!(!receipt.save_as);
    assert_eq!(application.current().unwrap().target, Some(target("detached.fms")));
    assert!(!application.current().unwrap().dirty);
    assert_eq!(application.repository().commit_count(), 1);
}

#[test]
fn detached_save_refuses_an_existing_target_context() {
    let repository = FakeRepository::default();
    repository.seed(
        "detached.fms",
        ProjectEnvelope::blank(ProjectId::new(), "Existing").unwrap(),
    );
    let mut application = ProjectApplication::new(repository);
    application
        .create(CreateProjectRequest::new("Detached"))
        .unwrap();

    let error = application
        .save_detached(target("detached.fms"), None)
        .expect_err("detached Save must remain create-only");
    assert!(matches!(error, ApplicationError::Repository(_)));
    assert!(application.current().unwrap().dirty);
}

#[test]
fn raw_unknown_fields_and_asset_bytes_survive_save_as() {
    let repository = FakeRepository::default();
    let project_id = ProjectId::parse("project-source").unwrap();
    let mut envelope = ProjectEnvelope::blank(project_id.clone(), "Source").unwrap();
    let scene = RawJsonEnvelope::from_value(json!({
        "version": "scene.v2",
        "revision": 0,
        "scene": {"id": "scene", "name": "Source"},
        "objects": [{"id": "object-1", "transform": {"rotation": [0, 0, 0.5, 0.8660254], "scale": [2, 3, 4]}}],
        "future_field": {"keep": [1, 2, 3]}
    }))
    .unwrap();
    envelope.replace_scene(scene).unwrap();
    envelope
        .assets
        .push(OpaqueAsset::new("project/assets/mesh.bin", vec![0, 1, 2, 255], None).unwrap());
    let original_scene_bytes = envelope.definition.scene.raw_bytes().to_vec();
    let original_asset_bytes = envelope.assets[0].bytes().to_vec();
    repository.seed("source.fms", envelope);
    let mut application = ProjectApplication::new(repository);
    application
        .open(ProjectSource::Path(PathBuf::from("source.fms")))
        .unwrap();
    application.mark_dirty().unwrap();
    let receipt = application
        .save_as(SaveAsProjectRequest {
            target: target("copy.fms"),
            project_id: Some(ProjectId::parse("project-copy").unwrap()),
            client_intent_id: None,
        })
        .unwrap();
    assert!(receipt.save_as);
    assert_ne!(receipt.project_id, project_id);
    let copied = application.repository().stored("copy.fms");
    assert_eq!(copied.assets[0].bytes(), original_asset_bytes.as_slice());
    assert_eq!(
        copied
            .definition
            .scene
            .value()
            .get("future_field")
            .and_then(|value| value.get("keep"))
            .and_then(|value| value.as_array())
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        copied.definition.scene.raw_bytes(),
        original_scene_bytes.as_slice()
    );
    assert_eq!(
        application
            .repository()
            .stored("source.fms")
            .definition
            .project_id,
        project_id
    );
}

#[test]
fn unknown_schema_is_openable_read_only_but_cannot_save() {
    let repository = FakeRepository::default();
    let project_id = ProjectId::parse("project-future").unwrap();
    let mut envelope = ProjectEnvelope::blank(project_id, "Future").unwrap();
    envelope.definition.schema_version = "fullmag.project.v9".into();
    envelope.rewrite_known_fields().unwrap();
    repository.seed_open_record(
        "future.fms",
        RepositoryOpenResult {
            envelope,
            source: ProjectSource::Path(PathBuf::from("future.fms")),
            source_hash: Some("future-hash".into()),
            target: Some(target("future.fms")),
            migration: MigrationReport::unsupported("fullmag.project.v9", "future schema"),
            read_only_reason: Some("unknown project schema".into()),
        },
    );
    let mut application = ProjectApplication::new(repository);
    let opened = application
        .open(ProjectSource::Path(PathBuf::from("future.fms")))
        .unwrap();
    assert!(matches!(opened.view.mode, DocumentMode::ReadOnly { .. }));
    let error = application
        .save(SaveProjectRequest::default())
        .expect_err("unknown schema must not reach a writer");
    assert!(matches!(error, ApplicationError::ReadOnly { .. }));
    assert_eq!(application.repository().commit_count(), 0);
}

#[test]
fn save_rejects_stale_expected_revision_and_leaves_dirty_context() {
    let repository = FakeRepository::default();
    let project_id = ProjectId::parse("project-revision").unwrap();
    let envelope = ProjectEnvelope::blank(project_id, "Revision").unwrap();
    repository.seed("revision.fms", envelope);
    let mut application = ProjectApplication::new(repository);
    application
        .open(ProjectSource::Path(PathBuf::from("revision.fms")))
        .unwrap();
    application.mark_dirty().unwrap();
    let error = application
        .save(SaveProjectRequest {
            target: None,
            expected_revision: Some(99),
            client_intent_id: None,
        })
        .expect_err("stale command revision must be rejected");
    assert!(matches!(error, ApplicationError::RevisionConflict { .. }));
    assert!(application.current().unwrap().dirty);
}

#[test]
fn close_requires_explicit_active_execution_policy_and_never_cancels_runtime() {
    let repository = FakeRepository::default();
    let mut application = ProjectApplication::new(repository);
    application
        .create(CreateProjectRequest::new("Running"))
        .unwrap();
    application.set_active_execution("run-1").unwrap();
    let error = application.close(CloseRequest {
        dirty: DirtyClosePolicy::Discard,
        active_execution: ActiveExecutionPolicy::Refuse,
    });
    assert!(matches!(
        error,
        Err(ApplicationError::ActiveExecutionRequiresAction { .. })
    ));

    let result = application
        .close(CloseRequest {
            dirty: DirtyClosePolicy::Discard,
            active_execution: ActiveExecutionPolicy::KeepRunning,
        })
        .unwrap();
    assert!(result.discarded_dirty_draft);
    assert!(result.runtime_left_untouched);
}

#[test]
fn save_cannot_redirect_an_existing_document_to_another_target() {
    let repository = FakeRepository::default();
    let source = ProjectEnvelope::blank(ProjectId::new(), "Source").unwrap();
    let other = ProjectEnvelope::blank(ProjectId::new(), "Other").unwrap();
    repository.seed("source.fms", source);
    repository.seed("other.fms", other.clone());
    let mut application = ProjectApplication::new(repository);
    application
        .open(ProjectSource::Path("source.fms".into()))
        .unwrap();
    application.mark_dirty().unwrap();
    assert!(matches!(
        application.save(SaveProjectRequest {
            target: Some(target("other.fms")),
            ..Default::default()
        }),
        Err(ApplicationError::InvalidRequest(_))
    ));
    assert_eq!(application.repository().stored("other.fms"), other);
    assert_eq!(application.repository().commit_count(), 0);
    assert!(application.current().unwrap().dirty);
}

#[test]
fn stale_repository_identity_refuses_save_even_at_the_same_revision() {
    let repository = FakeRepository::default();
    repository.seed(
        "project.fms",
        ProjectEnvelope::blank(ProjectId::new(), "Original").unwrap(),
    );
    let mut application = ProjectApplication::new(repository);
    application
        .open(ProjectSource::Path("project.fms".into()))
        .unwrap();
    application.mark_dirty().unwrap();
    let replacement = ProjectEnvelope::blank(ProjectId::new(), "Replacement").unwrap();
    application
        .repository()
        .seed("project.fms", replacement.clone());
    assert!(matches!(
        application.save(SaveProjectRequest::default()),
        Err(ApplicationError::Repository(_))
    ));
    assert_eq!(application.repository().stored("project.fms"), replacement);
    assert!(application.current().unwrap().dirty);
}

#[test]
fn future_scene_is_read_only_even_when_the_adapter_claims_it_is_current() {
    let repository = FakeRepository::default();
    let mut envelope = ProjectEnvelope::blank(ProjectId::new(), "Future scene").unwrap();
    envelope
        .replace_scene(RawJsonEnvelope::from_value(json!({"version": "scene.v9"})).unwrap())
        .unwrap();
    repository.seed("future.fms", envelope);
    let mut application = ProjectApplication::new(repository);
    let opened = application
        .open(ProjectSource::Path("future.fms".into()))
        .unwrap();
    assert!(matches!(opened.view.mode, DocumentMode::ReadOnly { .. }));
    assert!(matches!(
        application.save(SaveProjectRequest::default()),
        Err(ApplicationError::ReadOnly { .. })
    ));
    assert_eq!(application.repository().commit_count(), 0);
}

#[test]
fn deserialization_cannot_bypass_project_identity_validation() {
    for invalid in ["../escape", "NUL", "a/b", "trailing."] {
        assert!(serde_json::from_value::<ProjectId>(json!(invalid)).is_err());
    }
    let valid = ProjectId::new();
    assert_eq!(
        serde_json::from_value::<ProjectId>(json!(valid)).unwrap(),
        valid
    );
}

#[test]
fn save_as_cannot_reassign_an_active_execution_to_a_new_project() {
    let mut application = ProjectApplication::new(FakeRepository::default());
    let initial = application
        .create(CreateProjectRequest::new("Running draft"))
        .unwrap();
    application.set_active_execution("run-1").unwrap();
    let before = application.current().unwrap();
    assert!(matches!(
        application.save_as(SaveAsProjectRequest {
            target: target("copy.fms"),
            project_id: None,
            client_intent_id: None,
        }),
        Err(ApplicationError::ActiveExecutionRequiresAction { .. })
    ));
    assert_eq!(application.current().unwrap(), before);
    assert_eq!(application.repository().commit_count(), 0);

    application.finish_execution("run-1").unwrap();
    let receipt = application
        .save_as(SaveAsProjectRequest {
            target: target("copy.fms"),
            project_id: None,
            client_intent_id: None,
        })
        .unwrap();
    assert_ne!(receipt.project_id, initial.project_id);
    assert!(application.current().unwrap().active_execution.is_none());
}

#[test]
fn stale_completion_cannot_clear_or_replace_a_newer_execution() {
    let mut application = ProjectApplication::new(FakeRepository::default());
    application
        .create(CreateProjectRequest::new("Draft"))
        .unwrap();
    application.set_active_execution("run-1").unwrap();
    application.finish_execution("run-1").unwrap();
    application.set_active_execution("run-2").unwrap();
    let before = application.current().unwrap();
    assert!(application.finish_execution("run-1").is_err());
    assert!(application.set_active_execution("run-3").is_err());
    assert_eq!(application.current().unwrap(), before);
}
