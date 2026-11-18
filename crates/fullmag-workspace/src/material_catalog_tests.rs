use super::versions::read_published_material_versions_at;
use super::*;
use serde_json::json;

fn draft() -> MaterialLibraryWriteRequest {
    serde_json::from_value(json!({
        "id": "custom:sample",
        "name": "Measured YIG",
        "properties": {
            "Ms": 143000.0, "Aex": 3.6e-12, "alpha": 0.0002, "Dind": -0.001, "Dbulk": null
        },
        "references": [{"label": "Paper", "url": "https://example.org/report"}]
    }))
    .unwrap()
}

fn publish_request(material_id: &str, base_revision: u64) -> MaterialVersionPublishRequest {
    MaterialVersionPublishRequest {
        material_id: material_id.into(),
        base_revision,
        family: "yig".into(),
        version: "kuswik1".into(),
        display_name: "YIG_Kuswik1".into(),
        source_project: Some("Earlier experiment".into()),
    }
}

#[test]
fn open_migrates_v1_without_revising_the_catalog_or_rewriting_drafts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(SCHEMA_V1_SQL).unwrap();
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    let document = json!({
        "id": "custom:sample", "revision": 3, "name": "Legacy draft",
        "summary": null, "kind": "custom", "source": null, "references": [],
        "properties": {"Ms": 140000, "Aex": null, "alpha": 0.0001, "Dind": null, "Dbulk": null}
    })
    .to_string();
    connection
        .execute("UPDATE catalog_state SET revision=5", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO material_entries VALUES('custom:sample',3,?1)",
            [&document],
        )
        .unwrap();
    drop(connection);

    assert!(read_published_material_versions_at(&path)
        .unwrap()
        .is_empty());
    let connection = Connection::open(&path).unwrap();
    assert_eq!(database_identity(&connection).unwrap(), (APPLICATION_ID, 1));
    drop(connection);

    let store = MaterialLibraryStore::open(&path).unwrap();
    assert_eq!(
        database_identity(&store.connection).unwrap(),
        (APPLICATION_ID, 2)
    );
    let catalog = store.list().unwrap();
    assert_eq!(catalog.revision, 5);
    assert!(catalog.versions.is_empty());
    let saved = catalog
        .entries
        .iter()
        .find(|entry| entry.id == "custom:sample")
        .unwrap();
    assert_eq!(saved.revision, 3);
    assert_eq!(saved.name, "Legacy draft");
    assert!(saved.source_project.is_none());
    assert!(serde_json::to_value(saved)
        .unwrap()
        .get("source_project")
        .is_none());
    let persisted: String = store
        .connection
        .query_row(
            "SELECT document FROM material_entries WHERE id='custom:sample'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted, document);
}

#[test]
fn publishing_pins_properties_references_and_builtin_original_after_draft_deletion() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.sqlite3");
    let mut store = MaterialLibraryStore::open(&path).unwrap();
    let mut input = draft();
    input.source = Some(builtin_entry("nickel").unwrap().source_snapshot());
    let saved = store.create_with_revision(input.clone()).unwrap();
    let published = store
        .publish(publish_request(&saved.material.id, saved.material.revision))
        .unwrap();

    input.properties.ms = Some(150000.0);
    input.references.clear();
    let edited = store
        .update_with_revision(&saved.material.id, input, saved.material.revision)
        .unwrap();
    store
        .delete(&edited.material.id, edited.material.revision)
        .unwrap();
    drop(store);

    let versions = read_published_material_versions_at(&path).unwrap();
    assert_eq!(versions, vec![published.published.clone()]);
    let version = &versions[0];
    assert_eq!(version.source.catalog_id, "custom:published:yig:kuswik1");
    assert_eq!(version.source.properties.ms, Some(143000.0));
    assert_eq!(version.source.properties.dind, Some(-0.001));
    assert_eq!(
        version.source.references[0].url.as_deref(),
        Some("https://example.org/report")
    );
    let key = version.source.version.as_ref().unwrap();
    assert_eq!(key.source_project.as_deref(), Some("Earlier experiment"));
    assert_eq!(key.copied_from_family.as_deref(), Some("nickel"));
    let original = version.original.as_ref().unwrap();
    assert_eq!(original.catalog_id, "builtin:yig");
    assert_eq!(original.properties.ms, Some(140000.0));
}

#[test]
fn metadata_changes_and_archival_share_catalog_clock_without_changing_the_pin() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.sqlite3")).unwrap();
    let published = store.publish(publish_request("builtin:yig", 1)).unwrap();
    let mut concurrent =
        MaterialLibraryStore::open(&directory.path().join("library.sqlite3")).unwrap();
    let saved = concurrent.create_with_revision(draft()).unwrap();

    let patch = MaterialVersionUpdateRequest {
        base_revision: published.published.revision,
        display_name: "New label".into(),
        archived: true,
    };
    let updated = store
        .update_version("yig", "kuswik1", patch.clone())
        .unwrap();
    assert_eq!(updated.catalog_revision, saved.catalog_revision + 1);
    assert!(matches!(
        store.update_version("yig", "kuswik1", patch),
        Err(MaterialLibraryError::Conflict(_))
    ));
    assert!(matches!(
        store.publish(publish_request("builtin:yig", 1)),
        Err(MaterialLibraryError::Conflict(_))
    ));
    let catalog = store.list().unwrap();
    assert_eq!(catalog.versions, [updated.published.clone()]);
    assert_eq!(catalog.revision, updated.catalog_revision);
    assert_eq!(updated.published.revision, updated.catalog_revision);
    assert_eq!(updated.published.source, published.published.source);
    assert_eq!(updated.published.original, published.published.original);
    assert_eq!(updated.published.source.name, "YIG_Kuswik1");
    assert_eq!(updated.published.display_name, "New label");
    assert!(updated.published.archived);
}

#[test]
fn rejects_incomplete_drafts_reserved_ids_and_invalid_python_keys() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.sqlite3")).unwrap();
    let mut input = draft();
    input.properties.aex = None;
    let saved = store.create_with_revision(input.clone()).unwrap();
    assert!(matches!(
        store.publish(publish_request(&saved.material.id, 1)),
        Err(MaterialLibraryError::Conflict(_))
    ));
    assert!(matches!(
        store.publish(publish_request(&saved.material.id, saved.material.revision)),
        Err(MaterialLibraryError::Invalid(_))
    ));
    input.properties.aex = Some(0.0);
    let saved = store
        .update_with_revision(&saved.material.id, input.clone(), saved.material.revision)
        .unwrap();
    assert_eq!(saved.material.properties.aex, Some(0.0));
    assert!(matches!(
        store.publish(publish_request(&saved.material.id, saved.material.revision)),
        Err(MaterialLibraryError::Invalid(_))
    ));
    input.id = Some("custom:published:yig:kuswik1".into());
    assert!(matches!(
        store.create_with_revision(input),
        Err(MaterialLibraryError::Invalid(_))
    ));
    let mut request = publish_request("builtin:yig", 1);
    for key in [
        "",
        "Yig",
        "class",
        "_private",
        "ni-fe",
        "yíg",
        "yig_very_long_family_name_rejected_because_of_length",
    ] {
        request.version = key.into();
        assert!(
            matches!(
                store.publish(request.clone()),
                Err(MaterialLibraryError::Invalid(_))
            ),
            "{key}"
        );
    }
    let catalog = store.list().unwrap();
    assert_eq!(catalog.revision, saved.catalog_revision);
    assert!(catalog.versions.is_empty());
}

#[test]
fn reading_when_catalog_is_absent_has_no_filesystem_side_effect() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("new-profile").join("library.sqlite3");
    assert!(read_published_material_versions_at(&path)
        .unwrap()
        .is_empty());
    assert!(!path.parent().unwrap().exists());
}

#[test]
fn bounded_reader_accounts_for_delimiters_and_rejects_large_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.sqlite3");
    let mut store = MaterialLibraryStore::open(&path).unwrap();
    let first = store.publish(publish_request("builtin:yig", 1)).unwrap();
    let mut request = publish_request("builtin:yig", 1);
    request.version = "sample_2".into();
    let second = store.publish(request).unwrap();
    let expected = vec![first.published, second.published];
    let encoded_bytes = serde_json::to_vec(&expected).unwrap().len();
    let transaction = store.connection.unchecked_transaction().unwrap();
    assert_eq!(
        versions::read_versions(&transaction, encoded_bytes).unwrap(),
        expected
    );
    assert!(matches!(
        versions::read_versions(&transaction, encoded_bytes - 1),
        Err(MaterialLibraryError::Invalid(_))
    ));
}

#[test]
fn catalog_capacity_rejects_growth_without_advancing_revision_and_allows_shrinking() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.sqlite3");
    let mut store = MaterialLibraryStore::open(&path).unwrap();
    let first = store.publish(publish_request("builtin:yig", 1)).unwrap();
    let mut request = publish_request("builtin:yig", 1);
    request.version = "sample_2".into();
    let second = store.publish(request.clone()).unwrap();

    // A valid noncanonical document models a catalog already at its wire limit.
    let first_document = serde_json::to_string(&first.published).unwrap();
    let mut pad = first_document.clone();
    pad.push_str(&" ".repeat(MAX_PUBLISHED_MATERIAL_CATALOG_BYTES + 1 - first_document.len()));
    store.connection.execute(
        "UPDATE published_material_versions SET document=?1 WHERE family='yig' AND version='kuswik1'",
        [&pad],
    ).unwrap();

    request.version = "sample_3".into();
    assert!(matches!(
        store.publish(request.clone()),
        Err(MaterialLibraryError::Invalid(_))
    ));
    let alias = MaterialVersionUpdateRequest {
        base_revision: second.published.revision,
        display_name: "An alias that needs more bytes".into(),
        archived: false,
    };
    assert!(matches!(
        store.update_version("yig", "sample_2", alias),
        Err(MaterialLibraryError::Invalid(_))
    ));
    let unchanged = store.list().unwrap();
    assert_eq!(unchanged.revision, second.catalog_revision);
    assert_eq!(
        unchanged.versions,
        [first.published.clone(), second.published]
    );
    assert!(read_published_material_versions_at(&path).is_err());

    let repaired = store
        .update_version(
            "yig",
            "kuswik1",
            MaterialVersionUpdateRequest {
                base_revision: first.published.revision,
                display_name: "Kuswik 1".into(),
                archived: true,
            },
        )
        .unwrap();
    assert_eq!(repaired.catalog_revision, second.catalog_revision + 1);
    assert_eq!(repaired.published.source, first.published.source);
    assert_eq!(read_published_material_versions_at(&path).unwrap().len(), 2);
    assert!(store.publish(request).is_ok());
}

#[test]
fn corrupt_published_source_cannot_enter_a_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.sqlite3");
    let mut store = MaterialLibraryStore::open(&path).unwrap();
    let mut request = publish_request("builtin:yig", 1);
    request.family = "sample".into();
    let mut published = store.publish(request).unwrap().published;
    assert!(published.original.is_none());

    published.source.properties.ms = None;
    store
        .connection
        .execute(
            "UPDATE published_material_versions SET document=?1",
            [serde_json::to_string(&published).unwrap()],
        )
        .unwrap();
    for failure in [
        store.list().unwrap_err(),
        read_published_material_versions_at(&path).unwrap_err(),
    ] {
        assert!(matches!(failure, MaterialLibraryError::Storage(_)));
        assert!(failure.to_string().contains("sample.kuswik1"));
    }
}

#[test]
fn publishing_a_reopened_draft_prefers_its_copied_project_over_the_upstream_project() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.sqlite3");
    let mut store = MaterialLibraryStore::open(&path).unwrap();
    let upstream = store
        .publish(publish_request("builtin:yig", 1))
        .unwrap()
        .published
        .source;
    let mut input = draft();
    input.source = Some(upstream.clone());
    input.source_project = Some("Reopened project".into());
    let saved = store.create_with_revision(input).unwrap();
    assert_eq!(
        saved.material.source_project.as_deref(),
        Some("Reopened project")
    );
    drop(store);

    let mut store = MaterialLibraryStore::open(&path).unwrap();
    let catalog = store.list().unwrap();
    let saved = catalog
        .entries
        .iter()
        .find(|entry| entry.id == saved.material.id)
        .unwrap();
    assert_eq!(saved.source_project.as_deref(), Some("Reopened project"));
    assert_eq!(saved.source.as_ref(), Some(&upstream));

    let mut rename = draft();
    rename.name = "Sample after reopening".into();
    let updated = store
        .update_with_revision(&saved.id, rename.clone(), saved.revision)
        .unwrap()
        .material;
    assert_eq!(updated.source_project, saved.source_project);
    assert_eq!(updated.source, saved.source);

    rename.source_project = Some("Different project".into());
    assert!(matches!(
        store.update_with_revision(&updated.id, rename, updated.revision),
        Err(MaterialLibraryError::Invalid(_))
    ));

    let mut publication = publish_request(&updated.id, updated.revision);
    publication.version = "second_measurement".into();
    publication.source_project = Some("Explicit publish fallback".into());
    let source = store.publish(publication).unwrap().published.source;
    assert_eq!(
        source.version.unwrap().source_project.as_deref(),
        Some("Reopened project")
    );
    assert_eq!(
        upstream.version.unwrap().source_project.as_deref(),
        Some("Earlier experiment")
    );
}

#[test]
fn draft_source_project_validates_blank_and_utf8_byte_length() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.sqlite3")).unwrap();
    let mut input = draft();
    for value in [" \t\n".into(), "é".repeat(2049)] {
        input.source_project = Some(value);
        assert!(matches!(
            store.create_with_revision(input.clone()),
            Err(MaterialLibraryError::Invalid(_))
        ));
    }
    let maximum = "é".repeat(2048);
    input.source_project = Some(maximum.clone());
    let saved = store.create_with_revision(input).unwrap();
    assert_eq!(
        saved.material.source_project.as_deref(),
        Some(maximum.as_str())
    );
    assert_eq!(saved.catalog_revision, 2);
}
