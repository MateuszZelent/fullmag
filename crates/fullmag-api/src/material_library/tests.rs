use crate::material_library::{MaterialLibraryStore, MaterialLibraryWriteRequest};
use serde_json::json;

fn custom(id: &str) -> MaterialLibraryWriteRequest {
    serde_json::from_value(json!({
        "id": id, "name": "My Permalloy", "summary": "Measured sample",
        "properties": {"Ms": 800000.0, "Aex": 1.3e-11, "alpha": 0.01,
                       "Dind": null, "Dbulk": null},
        "references": [{"label": "Measurement", "citation": "Sample A"},
                       {"label": "Method", "url": "https://example.org/method"}]
    }))
    .unwrap()
}

#[test]
fn persists_custom_entries_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("material-library.sqlite3");
    let mut store = MaterialLibraryStore::open(&path).unwrap();
    let saved = store.create(custom("custom:sample-a")).unwrap();
    let revision = store.list().unwrap().revision;
    drop(store);
    let store = MaterialLibraryStore::open(&path).unwrap();
    let catalog = store.list().unwrap();
    assert_eq!(catalog.revision, revision);
    assert_eq!(catalog.entries.len(), 6);
    let loaded = catalog
        .entries
        .iter()
        .find(|entry| entry.id == saved.id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(loaded).unwrap(),
        serde_json::to_value(saved).unwrap()
    );
}

#[test]
fn builtins_cannot_be_changed_or_deleted() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    let catalog = store.list().unwrap();
    assert_eq!(
        catalog
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        [
            "builtin:permalloy",
            "builtin:cofeb",
            "builtin:yig",
            "builtin:nickel",
            "builtin:iron"
        ]
    );
    for entry in catalog.entries {
        assert!(store
            .update(&entry.id, custom(&entry.id), entry.revision)
            .unwrap_err()
            .to_string()
            .contains("read-only"));
        assert!(store
            .delete(&entry.id, entry.revision)
            .unwrap_err()
            .to_string()
            .contains("read-only"));
        assert!(store.create(custom(&entry.id)).is_err());
    }
    assert_eq!(store.list().unwrap().entries.len(), 5);
}

#[test]
fn create_collision_is_not_update() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    let first = store.create(custom("custom:one")).unwrap();
    let mut duplicate = custom("custom:one");
    duplicate.name = "Overwrite attempt".into();
    assert!(store
        .create(duplicate)
        .unwrap_err()
        .to_string()
        .contains("conflict"));
    let catalog = store.list().unwrap();
    let original = catalog
        .entries
        .iter()
        .find(|entry| entry.id == first.id)
        .unwrap();
    assert_eq!(original.name, "My Permalloy");
    assert_eq!(original.revision, first.revision);
}

#[test]
fn stale_update_is_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    let saved = store.create(custom("custom:one")).unwrap();
    let mut patch = custom("custom:one");
    patch.properties.ms = Some(900000.0);
    let updated = store
        .update(&saved.id, patch.clone(), saved.revision)
        .unwrap();
    assert_eq!(updated.revision, saved.revision + 1);
    assert!(store
        .update(&saved.id, patch, saved.revision)
        .unwrap_err()
        .to_string()
        .contains("conflict"));
    assert!(store.delete(&saved.id, saved.revision).is_err());
}

#[test]
fn source_snapshot_survives_parent_removal() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    let parent = store.create(custom("custom:parent")).unwrap();
    let mut variant = custom("custom:variant");
    variant.source = Some(parent.source_snapshot());
    variant.properties.ms = Some(900000.0);
    let child = store.create(variant).unwrap();
    store.delete(&parent.id, parent.revision).unwrap();
    let catalog = store.list().unwrap();
    let loaded = catalog
        .entries
        .iter()
        .find(|entry| entry.id == child.id)
        .unwrap();
    let source = loaded.source.as_ref().unwrap();
    assert_eq!(source.catalog_id, parent.id);
    assert_eq!(source.properties.ms, Some(800000.0));
    assert_eq!(loaded.properties.ms, Some(900000.0));
    assert_eq!(serde_json::to_value(&loaded.kind).unwrap(), "modified");
}

#[test]
fn validates_finite_values_and_required_alpha() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    for value in [f64::NAN, f64::INFINITY, -1.0] {
        let mut input = custom("custom:bad");
        input.properties.alpha = value;
        assert!(store.create(input).is_err());
    }
    let mut input = custom("custom:bad-ms");
    input.properties.ms = Some(-1.0);
    assert!(store.create(input).is_err());
    let mut input = custom("custom:bad-aex");
    input.properties.aex = Some(f64::INFINITY);
    assert!(store.create(input).is_err());
    let mut input = custom("custom:signed-dmi");
    input.properties.dind = Some(-0.001);
    input.properties.dbulk = Some(0.002);
    assert!(store.create(input).is_ok());
    assert!(
        serde_json::from_value::<MaterialLibraryWriteRequest>(json!({
            "name": "Missing alpha", "properties": {"Ms": 800000.0}
        }))
        .is_err()
    );
}

#[test]
fn preserves_all_references_and_rejects_unsafe_urls() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    let saved = store.create(custom("custom:references")).unwrap();
    assert_eq!(saved.references.len(), 2);
    let mut input = custom("custom:bad-url");
    input.references[0].url = Some("javascript:alert(1)".into());
    assert!(store.create(input).is_err());
}

#[test]
fn corrupted_database_is_not_replaced() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.db");
    std::fs::write(&path, b"unique invalid database").unwrap();
    assert!(MaterialLibraryStore::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"unique invalid database");
}

#[test]
fn material_library_scene_source_survives_save_and_does_not_change_execution_identity() {
    use fullmag_authoring::{
        scene_document_from_script_builder, scene_execution_input_identity, SceneMaterialAsset,
        ScriptBuilderMaterialState, ScriptBuilderState,
    };
    let directory = tempfile::tempdir().unwrap();
    let mut store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    let entry = store.create(custom("custom:scene-source")).unwrap();
    let mut scene = scene_document_from_script_builder(&ScriptBuilderState::default());
    scene.materials.push(SceneMaterialAsset {
        id: "mat:model-copy".into(),
        name: "Model copy".into(),
        properties: ScriptBuilderMaterialState {
            ms: entry.properties.ms,
            aex: entry.properties.aex,
            alpha: entry.properties.alpha,
            dind: None,
            dbulk: None,
        },
        references: Vec::new(),
        source: None,
    });
    let before = scene_execution_input_identity(&scene).unwrap();
    scene.materials[0].source = Some(entry.source_snapshot());
    let reloaded: fullmag_authoring::SceneDocument =
        serde_json::from_slice(&serde_json::to_vec(&scene).unwrap()).unwrap();
    assert_eq!(reloaded.materials[0].source, scene.materials[0].source);
    assert_eq!(scene_execution_input_identity(&reloaded).unwrap(), before);
    scene.materials[0].properties.ms = Some(900000.0);
    assert_ne!(scene_execution_input_identity(&scene).unwrap(), before);
    assert_eq!(
        scene.materials[0].source.as_ref().unwrap().properties.ms,
        Some(800000.0)
    );
}

#[test]
fn material_library_preserves_seed_values_and_reference_urls() {
    let directory = tempfile::tempdir().unwrap();
    let store = MaterialLibraryStore::open(&directory.path().join("library.db")).unwrap();
    let entries = store.list().unwrap().entries;
    for (entry, (id, ms, aex, alpha, doi)) in entries.iter().zip([
        (
            "builtin:permalloy",
            800000.0,
            1.3e-11,
            0.01,
            "10.1063/1.3072096",
        ),
        (
            "builtin:cofeb",
            1000000.0,
            1.5e-11,
            0.008,
            "10.1063/1.2711781",
        ),
        (
            "builtin:yig",
            140000.0,
            3.7e-12,
            1e-4,
            "10.1109/TMAG.1988.194098",
        ),
        (
            "builtin:nickel",
            485000.0,
            8e-12,
            0.03,
            "10.1103/RevModPhys.17.15",
        ),
        (
            "builtin:iron",
            1700000.0,
            2.1e-11,
            0.002,
            "10.1063/1.1724669",
        ),
    ]) {
        assert_eq!(entry.id, id);
        assert_eq!(entry.properties.ms, Some(ms));
        assert_eq!(entry.properties.aex, Some(aex));
        assert_eq!(entry.properties.alpha, alpha);
        assert!(entry.properties.dind.is_none() && entry.properties.dbulk.is_none());
        assert_eq!(
            entry.references[0].url.as_deref(),
            Some(format!("https://doi.org/{doi}").as_str())
        );
    }
}

#[test]
fn material_library_does_not_adopt_an_existing_unrecognized_sqlite_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("other.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE unique_user_data(value TEXT); INSERT INTO unique_user_data VALUES('keep me');").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(MaterialLibraryStore::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn recreated_id_rejects_stale_update_and_delete_from_its_previous_lifetime() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("library.sqlite3");
    let mut store = MaterialLibraryStore::open(&db).unwrap();
    let original = store.create(custom("custom:reused")).unwrap();
    store.delete(&original.id, original.revision).unwrap();
    let mut replacement = custom(&original.id);
    replacement.name = "Replacement sample".into();
    replacement.properties.ms = Some(950000.0);
    let replacement = store.create(replacement).unwrap();
    let before = serde_json::to_value(store.list().unwrap()).unwrap();
    assert!(replacement.revision > original.revision);
    assert!(matches!(
        store.update(&original.id, custom(&original.id), original.revision),
        Err(crate::material_library::MaterialLibraryError::Conflict(_))
    ));
    assert!(matches!(
        store.delete(&original.id, original.revision),
        Err(crate::material_library::MaterialLibraryError::Conflict(_))
    ));
    assert_eq!(serde_json::to_value(store.list().unwrap()).unwrap(), before);
    drop(store);
    let reopened = MaterialLibraryStore::open(&db).unwrap().list().unwrap();
    assert_eq!(
        reopened
            .entries
            .iter()
            .find(|entry| entry.id == replacement.id)
            .unwrap()
            .name,
        "Replacement sample"
    );
}
