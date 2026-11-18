use super::*;
use axum::body::Body;
use axum::http::{header, Method, Request};
use serde_json::{json, Value};
use tower::ServiceExt;

fn write_request(id: &str) -> MaterialLibraryWriteRequest {
    serde_json::from_value(json!({
        "id":id,"name":"Sample","properties":{"Ms":800000.0,"Aex":1.3e-11,"alpha":0.01},
        "references":[{"label":"Experiment","citation":"Sample A"},{"url":"https://example.org/method"}]
    })).unwrap()
}

#[test]
fn catalog_crud_persists_and_requires_current_entry_revision() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("material-library.sqlite3");
    let initial = list_at(&db).unwrap();
    assert_eq!(initial.entries.len(), 5);
    let response = create_at(&db, write_request("custom:sample")).unwrap();
    let saved = response.material;
    assert_eq!(saved.references.len(), 2);
    let after_create = list_at(&db).unwrap();
    assert!(after_create.revision > initial.revision);
    assert_eq!(response.catalog_revision, after_create.revision);
    let wire =
        serde_json::to_value(create_at(&db, write_request("custom:other")).unwrap()).unwrap();
    assert_eq!(wire["catalog_revision"], after_create.revision + 1);
    assert_eq!(wire["id"], "custom:other");
    assert!(after_create
        .entries
        .iter()
        .any(|entry| entry.id == saved.id));
    let update = MaterialLibraryUpdateRequest {
        base_revision: saved.revision,
        material: write_request(&saved.id),
    };
    let update_response = update_at(&db, &saved.id, update.clone()).unwrap();
    assert_eq!(update_response.catalog_revision, after_create.revision + 2);
    let updated = update_response.material;
    assert_ne!(update_response.catalog_revision, updated.revision);
    assert_eq!(updated.revision, saved.revision + 1);
    assert_eq!(
        update_at(&db, &saved.id, update).unwrap_err().status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        delete_at(
            &db,
            &saved.id,
            MaterialLibraryDeleteRequest {
                base_revision: saved.revision
            }
        )
        .unwrap_err()
        .status,
        StatusCode::CONFLICT
    );
    let deleted = delete_at(
        &db,
        &saved.id,
        MaterialLibraryDeleteRequest {
            base_revision: updated.revision,
        },
    )
    .unwrap();
    let remaining = list_at(&db).unwrap();
    assert_eq!(deleted.revision, remaining.revision);
    assert_eq!(remaining.entries.len(), 6);
    assert_eq!(
        delete_at(
            &db,
            &saved.id,
            MaterialLibraryDeleteRequest {
                base_revision: updated.revision
            }
        )
        .unwrap_err()
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        update_at(
            &db,
            &saved.id,
            MaterialLibraryUpdateRequest {
                base_revision: updated.revision,
                material: write_request(&saved.id)
            }
        )
        .unwrap_err()
        .status,
        StatusCode::NOT_FOUND
    );
}

#[test]
fn catalog_maps_collisions_builtin_guards_and_validation() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("library.sqlite3");
    let one = create_at(&db, write_request("custom:one"))
        .unwrap()
        .material;
    assert_eq!(
        create_at(&db, write_request("custom:one"))
            .unwrap_err()
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        update_at(
            &db,
            "builtin:permalloy",
            MaterialLibraryUpdateRequest {
                base_revision: 1,
                material: write_request("builtin:permalloy")
            }
        )
        .unwrap_err()
        .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        delete_at(
            &db,
            "builtin:permalloy",
            MaterialLibraryDeleteRequest { base_revision: 1 }
        )
        .unwrap_err()
        .status,
        StatusCode::CONFLICT
    );
    let mut invalid = write_request("custom:bad");
    invalid.properties.alpha = -0.1;
    assert_eq!(
        create_at(&db, invalid).unwrap_err().status,
        StatusCode::BAD_REQUEST
    );
    let mismatch = MaterialLibraryUpdateRequest {
        base_revision: one.revision,
        material: write_request("custom:other"),
    };
    assert_eq!(
        update_at(&db, "custom:one", mismatch).unwrap_err().status,
        StatusCode::BAD_REQUEST
    );
}

#[test]
fn catalog_source_survives_parent_delete_and_storage_failure_preserves_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("library.sqlite3");
    let parent = create_at(&db, write_request("custom:parent"))
        .unwrap()
        .material;
    let mut input = write_request("custom:variant");
    input.source = Some(parent.source_snapshot());
    input.properties.ms = Some(900000.0);
    let child = create_at(&db, input).unwrap().material;
    delete_at(
        &db,
        &parent.id,
        MaterialLibraryDeleteRequest {
            base_revision: parent.revision,
        },
    )
    .unwrap();
    let loaded = list_at(&db)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.id == child.id)
        .unwrap();
    assert_eq!(loaded.source.unwrap().properties.ms, Some(800000.0));
    assert_eq!(loaded.properties.ms, Some(900000.0));
    let broken = dir.path().join("broken.sqlite3");
    std::fs::write(&broken, b"unique invalid database").unwrap();
    assert_eq!(
        list_at(&broken).unwrap_err().status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read(broken).unwrap(), b"unique invalid database");
}

#[test]
fn invalid_stored_material_is_a_storage_failure_and_preserves_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("library.sqlite3");
    let saved = create_at(&db, write_request("custom:sample"))
        .unwrap()
        .material;
    let mut document = serde_json::to_value(saved).unwrap();
    document["properties"]["alpha"] = json!(-0.1);
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection
        .execute(
            "UPDATE material_entries SET document=?1 WHERE id='custom:sample'",
            [document.to_string()],
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&db).unwrap();
    let error = list_at(&db).unwrap_err();
    assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(std::fs::read(&db).unwrap(), before);
}

#[test]
fn catalog_version_routes_use_entry_revisions_and_preserve_published_source() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("library.sqlite3");
    let source = create_at(&db, write_request("custom:sample"))
        .unwrap()
        .material;
    create_at(&db, write_request("custom:unrelated")).unwrap();
    let request = MaterialVersionPublishRequest {
        material_id: source.id,
        base_revision: source.revision,
        family: "yig".into(),
        version: "sample_1".into(),
        display_name: "Sample 1".into(),
        source_project: Some("Saved project".into()),
    };
    let version = publish_at(&db, request.clone()).unwrap();
    assert_eq!(
        publish_at(&db, request).unwrap_err().status,
        StatusCode::CONFLICT
    );
    let patch = MaterialVersionUpdateRequest {
        base_revision: version.published.revision,
        display_name: "Renamed".into(),
        archived: true,
    };
    assert_eq!(
        patch_at(&db, "yig", "unknown", patch.clone())
            .unwrap_err()
            .status,
        StatusCode::NOT_FOUND
    );
    let archived = patch_at(&db, "yig", "sample_1", patch.clone()).unwrap();
    assert_eq!(
        patch_at(&db, "yig", "sample_1", patch).unwrap_err().status,
        StatusCode::CONFLICT
    );
    let wire = serde_json::to_value(list_at(&db).unwrap()).unwrap();
    assert_eq!(wire["revision"], archived.catalog_revision);
    assert_eq!(wire["versions"][0]["revision"], archived.catalog_revision);
    assert_eq!(wire["versions"][0]["archived"], true);
    assert_eq!(wire["versions"][0]["display_name"], "Renamed");
    assert_eq!(wire["versions"][0]["source"]["name"], "Sample 1");
    assert_eq!(
        wire["versions"][0]["source"]["version"],
        json!({
            "family": "yig", "version": "sample_1", "source_project": "Saved project"
        })
    );
    assert_eq!(wire["versions"][0]["original"]["catalog_id"], "builtin:yig");
}

#[tokio::test]
async fn catalog_routes_reject_invalid_json_as_400_without_session_or_storage() {
    let app =
        crate::router_v2::build_v2_router().with_state(crate::router_v2::tests::test_app_state());
    for (method, path, payload) in [
        (Method::POST, "/v2/workspace/material-library", "{"),
        (
            Method::POST,
            "/v2/workspace/material-library",
            r#"{"name":"Missing alpha","properties":{"Ms":800000}}"#,
        ),
        (
            Method::PUT,
            "/v2/workspace/material-library/custom:one",
            r#"{"name":"Missing revision","properties":{"alpha":0.01}}"#,
        ),
        (
            Method::DELETE,
            "/v2/workspace/material-library/custom:one",
            "{}",
        ),
        (
            Method::DELETE,
            "/v2/workspace/material-library/custom:one",
            r#"{"base_revision":null}"#,
        ),
        (
            Method::POST,
            "/v2/workspace/material-library/versions",
            r#"{"base_revision":1,"material_id":"builtin:yig","family":"yig","version":"sample"}"#,
        ),
        (
            Method::PATCH,
            "/v2/workspace/material-library/versions/yig/sample",
            r#"{"base_revision":1,"display_name":"Sample","archived":false,"properties":{}}"#,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-request-id", "material-library-test")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()["x-request-id"], "material-library-test");
        assert_eq!(response.headers()["x-api-contract-version"], "1.0.0");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "bad_request");
    }
}

#[test]
fn catalog_openapi_is_typed_and_independent_of_current_session_scope() {
    let document = crate::openapi_v2::openapi_json();
    for (path, methods) in [
        ("/v2/workspace/material-library", vec!["get", "post"]),
        ("/v2/workspace/material-library/{id}", vec!["put", "delete"]),
        ("/v2/workspace/material-library/versions", vec!["post"]),
        (
            "/v2/workspace/material-library/versions/{family}/{version}",
            vec!["patch"],
        ),
    ] {
        for method in methods {
            let operation = &document["paths"][path][method];
            assert!(operation.is_object(), "missing {method} {path}");
            assert!(!operation["parameters"]
                .to_string()
                .contains("FullmagSessionScope"));
            assert!(operation["responses"]["500"].is_object());
        }
    }
    let schemas = &document["components"]["schemas"];
    for name in [
        "MaterialLibraryResource",
        "MaterialLibraryEntryResource",
        "MaterialLibraryMutationResource",
        "MaterialLibraryWriteRequest",
        "MaterialLibraryUpdateRequest",
        "MaterialLibraryDeleteRequest",
        "MaterialLibraryDeleteResource",
        "PublishedMaterialVersion",
        "MaterialVersionPublishRequest",
        "MaterialVersionUpdateRequest",
        "MaterialVersionMutationResource",
        "SceneMaterialSource",
        "SceneMaterialVersionSource",
        "SceneMaterialSourceKind",
        "SceneMaterialSourceProperties",
        "SceneMaterialReference",
    ] {
        assert!(schemas[name].is_object(), "missing schema {name}");
    }
    assert!(schemas["MaterialLibraryDeleteRequest"]["required"]
        .as_array()
        .unwrap()
        .contains(&json!("base_revision")));
    assert!(schemas["MaterialLibraryUpdateRequest"]
        .to_string()
        .contains("base_revision"));
    for name in ["SceneMaterialResource", "MaterialResource"] {
        assert!(schemas[name]["properties"]["source"]
            .to_string()
            .contains("SceneMaterialSource"));
    }
    assert!(schemas["AuthoringTransactionRequest"]
        .to_string()
        .contains("assign_to_object_id"));
}
