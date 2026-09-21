use fullmag_application::{
    FileProjectRepository, OpaqueDocument, ProjectEnvelope, ProjectId, ProjectRepository,
    ProjectSource, ProjectTarget, RawJsonEnvelope, RepositoryCommitRequest,
};
use serde_json::json;
use std::fs;
use std::io::{Cursor, Write};
use tempfile::tempdir;
use zip::write::SimpleFileOptions;

fn target(path: &std::path::Path) -> ProjectTarget {
    ProjectTarget::Path(path.to_path_buf())
}

fn current_envelope() -> ProjectEnvelope {
    let mut envelope =
        ProjectEnvelope::blank(ProjectId::parse("project-file").unwrap(), "File").unwrap();
    envelope
        .replace_scene(
            RawJsonEnvelope::from_bytes(
                br#"{"version":"scene.v2","revision":0,"scene":{"id":"scene"},"objects":[{"object_id":"object-1","name":"Incomplete body","type":"box","transform":{"rotation":[0,0,0.5,0.8660254],"scale":[2,3,4]},"future_object_field":{"keep":true}}],"future":{"keep":true}}"#,
            )
            .unwrap(),
        )
        .unwrap();
    envelope.source =
        Some(OpaqueDocument::new("project/main.py", b"print('portable')".to_vec()).unwrap());
    envelope
        .opaque_documents
        .push(OpaqueDocument::new("project/future.bin", vec![0, 1, 2, 255]).unwrap());
    envelope
}

fn commit_create(
    repository: &FileProjectRepository,
    envelope: ProjectEnvelope,
    path: &std::path::Path,
) {
    repository
        .commit(RepositoryCommitRequest {
            envelope,
            target: target(path),
            expected_project_id: None,
            expected_revision: None,
            client_intent_id: Some("test-create".into()),
            save_as: false,
        })
        .unwrap();
}

#[test]
fn current_project_roundtrip_preserves_raw_bytes_and_opaque_documents() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("project.fms");
    let repository = FileProjectRepository::new();
    let envelope = current_envelope();
    let scene_bytes = envelope.definition.scene.raw_bytes().to_vec();
    commit_create(&repository, envelope, &path);

    let opened = repository.open(ProjectSource::Path(path.clone())).unwrap();
    assert_eq!(
        opened.envelope.definition.project_id.as_str(),
        "project-file"
    );
    assert_eq!(opened.envelope.definition.scene.raw_bytes(), scene_bytes);
    let object = opened
        .envelope
        .definition
        .scene
        .value()
        .get("objects")
        .and_then(|objects| objects.as_array())
        .and_then(|objects| objects.first())
        .expect("roundtrip should retain the incomplete object");
    assert_eq!(
        object.get("object_id").and_then(|value| value.as_str()),
        Some("object-1")
    );
    assert_eq!(
        object
            .get("transform")
            .and_then(|transform| transform.get("rotation"))
            .and_then(|rotation| rotation.as_array())
            .map(Vec::len),
        Some(4),
    );
    assert_eq!(
        object
            .get("transform")
            .and_then(|transform| transform.get("scale"))
            .and_then(|scale| scale.as_array())
            .map(Vec::len),
        Some(3),
    );
    assert_eq!(
        object
            .get("future_object_field")
            .and_then(|value| value.get("keep"))
            .and_then(|value| value.as_bool()),
        Some(true),
    );
    assert_eq!(
        opened.envelope.source.as_ref().unwrap().bytes(),
        b"print('portable')"
    );
    assert_eq!(
        opened
            .envelope
            .opaque_documents
            .iter()
            .find(|document| document.path() == "project/future.bin")
            .unwrap()
            .bytes(),
        &[0, 1, 2, 255]
    );
    assert!(opened.migration.can_write);
    assert!(opened.read_only_reason.is_none());
}

#[test]
fn encoded_archive_can_be_opened_from_bytes_without_filesystem_publication() {
    let repository = FileProjectRepository::new();
    let envelope = current_envelope();
    let bytes = repository.encode_archive(&envelope).unwrap();

    let opened = repository
        .open(ProjectSource::Bytes {
            display_name: "encoded.fms".into(),
            bytes,
        })
        .unwrap();

    assert!(opened.target.is_none());
    assert_eq!(
        opened.envelope.definition.project_id,
        envelope.definition.project_id
    );
    assert_eq!(
        opened.envelope.definition.scene.raw_bytes(),
        envelope.definition.scene.raw_bytes()
    );
    assert_eq!(opened.envelope.source, envelope.source);
}

#[test]
fn stale_revision_and_create_only_conflicts_do_not_replace_target() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("project.fms");
    let repository = FileProjectRepository::new();
    commit_create(&repository, current_envelope(), &path);
    let original = fs::read(&path).unwrap();
    let mut candidate = current_envelope();
    candidate.definition.revision = 1;
    candidate.rewrite_known_fields().unwrap();

    let stale = repository.commit(RepositoryCommitRequest {
        envelope: candidate.clone(),
        target: target(&path),
        expected_project_id: Some(ProjectId::parse("project-file").unwrap()),
        expected_revision: Some(99),
        client_intent_id: None,
        save_as: false,
    });
    assert!(stale.is_err());
    assert_eq!(fs::read(&path).unwrap(), original);

    let create_only = repository.commit(RepositoryCommitRequest {
        envelope: candidate,
        target: target(&path),
        expected_project_id: None,
        expected_revision: None,
        client_intent_id: None,
        save_as: true,
    });
    assert!(create_only.is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn second_writer_is_rejected_before_publication() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("project.fms");
    let repository = FileProjectRepository::new();
    commit_create(&repository, current_envelope(), &path);
    let original = fs::read(&path).unwrap();

    let lock_path = directory.path().join(".project.fms.fullmag-writer.lock");
    fs::write(&lock_path, b"writer-held-by-another-process").unwrap();

    let mut candidate = current_envelope();
    candidate.definition.revision = 1;
    candidate.rewrite_known_fields().unwrap();
    let error = repository
        .commit(RepositoryCommitRequest {
            envelope: candidate,
            target: target(&path),
            expected_project_id: Some(ProjectId::parse("project-file").unwrap()),
            expected_revision: Some(0),
            client_intent_id: Some("second-writer".into()),
            save_as: false,
        })
        .expect_err("a second writer must be rejected before publication");

    assert!(error.to_string().contains("writer lock"));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(
        lock_path.is_file(),
        "the active writer marker must remain intact"
    );
}

#[test]
fn legacy_session_is_migrated_to_new_target_without_mutating_original() {
    let directory = tempdir().unwrap();
    let source_path = directory.path().join("legacy.fms");
    let target_path = directory.path().join("migrated.fms");
    let options = SimpleFileOptions::default();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let session = json!({"schema":"fullmag.session.v1","title":"Legacy study"});
    let workspace = json!({
        "workspace_id":"legacy-workspace",
        "problem_name":"Legacy study",
        "script_ref":"project/main.py",
        "scene_document_ref":"project/scene_document.json"
    });
    for (path, value) in [
        ("manifest/session.json", session),
        ("manifest/workspace.json", workspace),
    ] {
        writer.start_file(path, options).unwrap();
        writer
            .write_all(serde_json::to_vec(&value).unwrap().as_slice())
            .unwrap();
    }
    writer.start_file("project/main.py", options).unwrap();
    writer.write_all(b"print('legacy')").unwrap();
    writer
        .start_file("project/scene_document.json", options)
        .unwrap();
    writer.write_all(br#"{"legacy":true}"#).unwrap();
    writer.start_file("project/ui_state.json", options).unwrap();
    writer.write_all(br#"{"theme":"dark"}"#).unwrap();
    let legacy_bytes = writer.finish().unwrap().into_inner();
    fs::write(&source_path, &legacy_bytes).unwrap();

    let repository = FileProjectRepository::new();
    let opened = repository
        .open(ProjectSource::Path(source_path.clone()))
        .unwrap();
    assert!(opened.migration.migrated);
    assert!(opened.migration.can_write);
    assert!(opened
        .migration
        .preserved_paths
        .iter()
        .any(|path| path == "project/scene_document.json"));
    assert_eq!(fs::read(&source_path).unwrap(), legacy_bytes);

    let result = repository
        .commit(RepositoryCommitRequest {
            envelope: opened.envelope,
            target: target(&target_path),
            expected_project_id: None,
            expected_revision: None,
            client_intent_id: None,
            save_as: true,
        })
        .unwrap();
    assert!(result.source_hash.is_some());
    assert_eq!(fs::read(&source_path).unwrap(), legacy_bytes);
    let migrated = repository.open(ProjectSource::Path(target_path)).unwrap();
    assert!(migrated.migration.can_write);
    assert!(migrated
        .envelope
        .opaque_documents
        .iter()
        .any(|document| document.path().contains("project/legacy/")));
}

#[test]
fn unsafe_archive_path_is_rejected_before_project_open() {
    let options = SimpleFileOptions::default();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer.start_file("../escape", options).unwrap();
    writer.write_all(b"blocked").unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let error = FileProjectRepository::new()
        .open(ProjectSource::Bytes {
            display_name: "unsafe.fms".into(),
            bytes,
        })
        .unwrap_err();
    assert!(error.to_string().contains("unsafe project archive path"));
}
