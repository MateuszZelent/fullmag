use std::fs;

use super::{
    ExecutionProfileCatalog, ExecutionProfileCatalogEntry, ProfileCatalogError,
    ProfilePublicationDisposition, EXECUTION_PROFILE_CATALOG_PATH, MAX_PROFILE_CATALOG_ENTRIES,
};
use crate::SessionStore;
use fullmag_ir::ExecutionProfileIR;

fn profile(profile_id: &str, version: &str, description: &str) -> ExecutionProfileIR {
    ExecutionProfileIR {
        profile_id: profile_id.into(),
        version: version.into(),
        description: description.into(),
        ..ExecutionProfileIR::default()
    }
}

#[test]
fn missing_catalog_reads_as_empty_without_creating_compute_directory() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("session-store")).unwrap();

    assert_eq!(
        store.read_execution_profile_catalog().unwrap(),
        ExecutionProfileCatalog::default()
    );
    assert!(!store.root().join("compute").exists());
}

#[test]
fn publish_survives_reopen_and_replay_returns_existing_before_revision_check() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("session-store")).unwrap();
    let profile = profile("exec-test", "v1", "GPU default");

    let published = store
        .publish_execution_profile(0, "intent-first", profile.clone())
        .unwrap();
    assert_eq!(
        published.disposition,
        ProfilePublicationDisposition::Published
    );
    assert_eq!(published.catalog.revision, 1);
    assert_eq!(published.entry.revision, 1);
    assert_eq!(published.entry.profile, profile);

    let root = store.root().to_path_buf();
    drop(store);
    let reopened = SessionStore::open_existing(root).unwrap();
    assert_eq!(
        reopened.read_execution_profile_catalog().unwrap(),
        published.catalog
    );

    let replay = reopened
        .publish_execution_profile(0, "intent-first", profile)
        .unwrap();
    assert_eq!(replay.disposition, ProfilePublicationDisposition::Existing);
    assert_eq!(replay.catalog.revision, 1);
    assert_eq!(replay.entry, published.entry);
}

#[test]
fn publication_rejects_intent_version_and_revision_conflicts_without_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("session-store")).unwrap();
    let original = profile("exec-main", "v1", "original");
    store
        .publish_execution_profile(0, "intent-original", original.clone())
        .unwrap();

    assert_eq!(
        store
            .publish_execution_profile(1, "intent-original", profile("exec-main", "v1", "changed"),)
            .unwrap_err(),
        ProfileCatalogError::IntentConflict
    );
    assert_eq!(
        store
            .publish_execution_profile(1, "intent-other", original.clone())
            .unwrap_err(),
        ProfileCatalogError::VersionConflict
    );
    assert_eq!(
        store
            .publish_execution_profile(0, "intent-new", profile("exec-new", "v1", "new"))
            .unwrap_err(),
        ProfileCatalogError::RevisionConflict {
            expected: 0,
            actual: 1,
        }
    );
    let catalog = store.read_execution_profile_catalog().unwrap();
    assert_eq!(catalog.revision, 1);
    assert_eq!(catalog.entries.len(), 1);
    assert_eq!(catalog.entries[0].profile, original);
}

#[test]
fn replay_accepts_canonical_equivalence_of_empty_sparse_blocks_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("session-store");
    let store = SessionStore::open(&root).unwrap();
    let mut requested = profile("exec-empty", "1", "");
    requested.defaults.resources =
        fullmag_ir::FieldPatch::Value(fullmag_ir::ComputeResourcePatchIR::default());
    let published = store
        .publish_execution_profile(0, "intent-empty", requested.clone())
        .unwrap();
    drop(store);
    let reopened = SessionStore::open_existing(root).unwrap();
    let saved = reopened.read_execution_profile_catalog().unwrap();
    assert_ne!(saved.entries[0].profile, requested);
    assert_eq!(
        saved.entries[0].profile.canonical_sha256().unwrap(),
        requested.canonical_sha256().unwrap()
    );
    let replay = reopened
        .publish_execution_profile(0, "intent-empty", requested)
        .unwrap();
    assert_eq!(replay.disposition, ProfilePublicationDisposition::Existing);
    assert_eq!(replay.entry.profile_sha256, published.entry.profile_sha256);
    assert_eq!(replay.catalog.revision, 1);
}

#[test]
fn corrupt_or_unknown_catalog_is_reported_and_never_treated_as_missing() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("session-store")).unwrap();
    let path = store.root().join(EXECUTION_PROFILE_CATALOG_PATH);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"{not json").unwrap();
    assert!(matches!(
        store.read_execution_profile_catalog(),
        Err(ProfileCatalogError::Invalid(_))
    ));

    fs::write(
        &path,
        br#"{"schema_version":"execution_profile_catalog.v2","revision":0,"entries":[]}"#,
    )
    .unwrap();
    assert!(matches!(
        store.read_execution_profile_catalog(),
        Err(ProfileCatalogError::Invalid(_))
    ));
}

#[test]
fn oversized_catalog_is_rejected_without_becoming_an_empty_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("session-store")).unwrap();
    let path = store.root().join(EXECUTION_PROFILE_CATALOG_PATH);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, vec![b' '; 4 * 1024 * 1024 + 1]).unwrap();

    assert!(store.read_execution_profile_catalog().is_err());
    assert_eq!(
        fs::metadata(path).unwrap().len(),
        (4 * 1024 * 1024 + 1) as u64
    );
}

#[test]
fn publication_refuses_catalog_entry_capacity_without_mutating_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("session-store")).unwrap();
    let mut catalog = ExecutionProfileCatalog::default();
    for index in 0..MAX_PROFILE_CATALOG_ENTRIES {
        let profile = profile(&format!("exec-{index}"), "v1", "");
        catalog.entries.push(ExecutionProfileCatalogEntry {
            profile_sha256: profile.canonical_sha256().unwrap(),
            profile,
            client_intent_id: format!("intent-{index}"),
            published_at: "2026-01-01T00:00:00Z".into(),
            revision: index as u64 + 1,
        });
    }
    catalog.revision = MAX_PROFILE_CATALOG_ENTRIES as u64;
    let bytes = serde_json::to_vec_pretty(&catalog).unwrap();
    assert!(bytes.len() < 4 * 1024 * 1024);
    let path = store.root().join(EXECUTION_PROFILE_CATALOG_PATH);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, &bytes).unwrap();

    assert_eq!(
        store
            .publish_execution_profile(
                catalog.revision,
                "intent-over-capacity",
                profile("exec-over-capacity", "v1", ""),
            )
            .unwrap_err(),
        ProfileCatalogError::CapacityExceeded
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}
