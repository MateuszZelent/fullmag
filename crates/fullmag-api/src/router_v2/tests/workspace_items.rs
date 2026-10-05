//! `/v2/workspace/...`: the per-user workspace database over HTTP.
//!
//! Operations are tested through the `*_at(db_path)` functions, which need no
//! process environment; a few router-level tests set `FULLMAG_STATE_DIR` under
//! a lock to prove the wiring (paths, methods, status codes, headers).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use fullmag_application::{
    FileProjectRepository, OpaqueDocument, ProjectEnvelope, ProjectId, ProjectRepository,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{body_bytes, body_json, build_v2_router, test_app_state};
use crate::router_v2::handlers::workspace_items::{
    add_item_at, forget_item_at, get_item_at, history_at, list_items_at, pin_item_at, put_roots_at,
    roots_at, scan_at, thumbnail_at, validate_roots,
};
use crate::schemas::workspace_items::{
    ItemDetail, WorkspaceAddRequest, WorkspaceHistoryQuery, WorkspaceItemKind, WorkspaceItemStatus,
    WorkspaceItemsQuery, WorkspaceOpenState, WorkspaceRoot, WorkspaceRootsSource,
};
use fullmag_workspace_inspect::manifest::{write_run_manifest, RunManifest, RunSource};
use fullmag_workspace_inspect::scanner::ScanOptions;

static ENV_LOCK: Mutex<()> = Mutex::new(());

const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

struct Fixture {
    dir: tempfile::TempDir,
    db: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state").join("workspace.db");
        Self { dir, db }
    }

    fn work(&self) -> PathBuf {
        let work = self.dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        work
    }
}

fn query(kind: &str) -> WorkspaceItemsQuery {
    WorkspaceItemsQuery {
        kind: Some(kind.to_string()),
        ..WorkspaceItemsQuery::default()
    }
}

fn write_script(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn write_project(path: &Path, id: &str, thumbnail: bool) {
    let mut envelope = ProjectEnvelope::blank(ProjectId::parse(id).unwrap(), "Wall").unwrap();
    if thumbnail {
        envelope
            .opaque_documents
            .push(OpaqueDocument::new("project/preview/thumb.png", PNG.to_vec()).unwrap());
    }
    let bytes = FileProjectRepository::new().encode_archive(&envelope).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn write_results(dir: &Path, script: Option<&Path>) {
    fs::create_dir_all(dir.join("artifacts")).unwrap();
    fs::write(dir.join(".zgroup"), r#"{"zarr_format":2}"#).unwrap();
    fs::write(
        dir.join(".zattrs"),
        json!({"fullmag_schema": "fullmag.script_results.v1"}).to_string(),
    )
    .unwrap();
    fs::write(
        dir.join("artifacts/scalars.csv"),
        "step,time,mx\n1,1e-13,0.1\n2,2e-13,0.2\n",
    )
    .unwrap();
    fs::write(
        dir.join("artifacts/metadata.json"),
        r#"{"status":"completed","scalar_rows":2,"field_snapshots":0}"#,
    )
    .unwrap();
    if let Some(script) = script {
        let manifest = RunManifest::new(
            "run-1",
            RunSource {
                kind: "script".into(),
                path: script.display().to_string(),
                sha256: None,
                project_id: None,
                revision: None,
            },
            "0.1.0",
            "2026-10-05T10:00:00.000Z",
        );
        write_run_manifest(dir, &manifest).unwrap();
    }
}

fn add(fixture: &Fixture, path: &Path) -> crate::schemas::workspace_items::WorkspaceItem {
    add_item_at(
        &fixture.db,
        &WorkspaceAddRequest {
            path: path.display().to_string(),
            kind: None,
        },
    )
    .unwrap_or_else(|error| panic!("add {}: {}", path.display(), error.message))
}

// ── list ───────────────────────────────────────────────────────────────────

#[test]
fn an_empty_workspace_lists_nothing_and_says_it_was_created() {
    let fixture = Fixture::new();
    let list = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert!(list.items.is_empty());
    assert_eq!(list.outcome.state, WorkspaceOpenState::Created);
    let again = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert_eq!(again.outcome.state, WorkspaceOpenState::Ready);
}

#[test]
fn added_items_list_by_kind_with_typed_fields_and_filters() {
    let fixture = Fixture::new();
    let work = fixture.work();
    let script = work.join("wall.py");
    write_script(&script, "\"\"\"Domain wall.\"\"\"\nimport fullmag\n");
    let project = work.join("wall.fms");
    write_project(&project, "pid-wall", true);
    let results = work.join("wall.zarr");
    write_results(&results, Some(&script));

    let script_item = add(&fixture, &script);
    let project_item = add(&fixture, &project);
    let result_item = add(&fixture, &results);
    assert_eq!(script_item.kind, WorkspaceItemKind::Script);
    assert_eq!(project_item.kind, WorkspaceItemKind::Project);
    assert_eq!(result_item.kind, WorkspaceItemKind::Result);
    assert_eq!(script_item.use_count, 1, "an explicit add counts as a use");
    assert!(script_item.id.chars().all(|c| c.is_ascii_digit()));
    assert!(project_item.has_thumbnail && !script_item.has_thumbnail);
    assert_eq!(script_item.meta["summary"], "Domain wall.");
    assert!(result_item.size_bytes.unwrap_or(0) > 0, "a result's size is its folder total");
    assert!(!script_item.path.starts_with(r"\\?\"));

    let all = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert_eq!(all.items.len(), 3);
    for (kind, expected) in [("project", 1), ("script", 1), ("result", 1)] {
        let list = list_items_at(&fixture.db, &query(kind)).unwrap();
        assert_eq!(list.items.len(), expected, "{kind}");
    }
    assert!(list_items_at(&fixture.db, &query("folder")).unwrap_err().status == StatusCode::BAD_REQUEST);
    let bad_sort = WorkspaceItemsQuery {
        sort: Some("shiny".into()),
        ..WorkspaceItemsQuery::default()
    };
    assert_eq!(list_items_at(&fixture.db, &bad_sort).unwrap_err().status, StatusCode::BAD_REQUEST);

    let search = WorkspaceItemsQuery {
        search: Some("WALL".into()),
        limit: Some(2),
        ..WorkspaceItemsQuery::default()
    };
    assert_eq!(list_items_at(&fixture.db, &search).unwrap().items.len(), 2);

    // A file that vanished reads as missing and can be hidden, without a write.
    fs::remove_file(&script).unwrap();
    let list = list_items_at(&fixture.db, &query("script")).unwrap();
    assert_eq!(list.items[0].status, WorkspaceItemStatus::Missing);
    let hidden = WorkspaceItemsQuery {
        kind: Some("script".into()),
        include_missing: Some(false),
        ..WorkspaceItemsQuery::default()
    };
    assert!(list_items_at(&fixture.db, &hidden).unwrap().items.is_empty());
}

#[test]
fn the_json_shape_of_an_item_is_the_documented_one() {
    let fixture = Fixture::new();
    let script = fixture.work().join("a.py");
    write_script(&script, "import fullmag\n");
    let item = add(&fixture, &script);
    let value = serde_json::to_value(&item).unwrap();
    let keys: std::collections::BTreeSet<&str> =
        value.as_object().unwrap().keys().map(String::as_str).collect();
    for key in [
        "id", "kind", "path", "name", "first_seen_at", "last_used_at", "use_count", "pinned",
        "status", "meta", "has_thumbnail", "size_bytes", "modified_at",
    ] {
        assert!(keys.contains(key), "missing {key}");
    }
    assert_eq!(value["id"], item.id);
    assert_eq!(value["kind"], "script");
    assert_eq!(value["status"], "ready");
    assert!(value["use_count"].is_number());
}

// ── detail ─────────────────────────────────────────────────────────────────

#[test]
fn a_script_detail_carries_static_facts_events_and_linked_results() {
    let fixture = Fixture::new();
    let work = fixture.work();
    let script = work.join("wall.py");
    write_script(&script, "import os\nimport fullmag\nx = os.environ['HOME_DIR']\n");
    let results = work.join("wall.zarr");
    write_results(&results, Some(&script));
    let script_item = add(&fixture, &script);
    let result_item = add(&fixture, &results);

    let detail = get_item_at(&fixture.db, &script_item.id).unwrap();
    let ItemDetail::Script(script_detail) = &detail.detail else {
        panic!("expected a script detail");
    };
    assert_eq!(script_detail.read_error, None);
    assert_eq!(script_detail.uses_fullmag, Some(true));
    assert_eq!(script_detail.env_reads.as_deref(), Some(&["HOME_DIR".to_string()][..]));
    assert!(script_detail.degraded && !script_detail.syntax_checked);
    assert_eq!(detail.linked_results.len(), 1);
    assert_eq!(detail.linked_results[0].id, result_item.id);
    assert!(detail.linked_source.is_none());
    assert!(detail.read_at.ends_with('Z'));
    assert_eq!(detail.events[0].kind, "import");

    // Viewing a script after it changed records one `edit`.
    write_script(&script, "import fullmag\nx = 2\n");
    let detail = get_item_at(&fixture.db, &script_item.id).unwrap();
    assert_eq!(detail.events[0].kind, "edit");
    assert_eq!(detail.events[0].actor, "web");
    assert_eq!(detail.events[0].detail["lines_after"], 2);
    let again = get_item_at(&fixture.db, &script_item.id).unwrap();
    assert_eq!(again.events.len(), detail.events.len(), "no second edit for one change");

    // The result points back at its script.
    let detail = get_item_at(&fixture.db, &result_item.id).unwrap();
    assert_eq!(detail.linked_source.as_ref().unwrap().id, script_item.id);
    let ItemDetail::Result(result) = &detail.detail else {
        panic!("expected a result detail");
    };
    assert_eq!(result.run_id.as_deref(), Some("run-1"));
    assert_eq!(result.stages.last().unwrap().steps, Some(2));
    assert_eq!(result.format.as_deref(), Some("zarr"));
}

#[test]
fn a_project_detail_reports_the_archive_and_a_damaged_one_a_read_error_not_an_http_error() {
    let fixture = Fixture::new();
    let work = fixture.work();
    let project = work.join("wall.fms");
    write_project(&project, "pid-wall", false);
    let item = add(&fixture, &project);
    let detail = get_item_at(&fixture.db, &item.id).unwrap();
    let ItemDetail::Project(project_detail) = &detail.detail else {
        panic!("expected a project detail");
    };
    assert_eq!(project_detail.read_error, None);
    assert_eq!(project_detail.project_id.as_deref(), Some("pid-wall"));
    assert_eq!(project_detail.mode.as_deref(), Some("read_write"));
    assert!(project_detail.summary.is_some());

    fs::write(&project, b"not a zip any more").unwrap();
    let detail = get_item_at(&fixture.db, &item.id).unwrap();
    let ItemDetail::Project(project_detail) = &detail.detail else {
        panic!("expected a project detail");
    };
    assert!(project_detail.read_error.as_deref().is_some_and(|text| !text.is_empty()));
    assert_eq!(detail.item.id, item.id);

    // A vanished script: still a 200 with the reason inside.
    let script = work.join("gone.py");
    write_script(&script, "import fullmag\n");
    let gone = add(&fixture, &script);
    fs::remove_file(&script).unwrap();
    let detail = get_item_at(&fixture.db, &gone.id).unwrap();
    assert_eq!(detail.item.status, WorkspaceItemStatus::Missing);
    assert!(detail.detail.read_error().is_some());
}

#[test]
fn bad_and_unknown_ids_are_400_and_404() {
    let fixture = Fixture::new();
    assert_eq!(get_item_at(&fixture.db, "abc").unwrap_err().status, StatusCode::BAD_REQUEST);
    assert_eq!(get_item_at(&fixture.db, "").unwrap_err().status, StatusCode::BAD_REQUEST);
    assert_eq!(get_item_at(&fixture.db, "-1").unwrap_err().status, StatusCode::BAD_REQUEST);
    assert_eq!(get_item_at(&fixture.db, "12345").unwrap_err().status, StatusCode::NOT_FOUND);
    assert_eq!(thumbnail_at(&fixture.db, "12345").unwrap_err().status, StatusCode::NOT_FOUND);
    assert_eq!(pin_item_at(&fixture.db, "12345", true).unwrap_err().status, StatusCode::NOT_FOUND);
    assert_eq!(forget_item_at(&fixture.db, "12345").unwrap_err().status, StatusCode::NOT_FOUND);
    assert_eq!(
        history_at(&fixture.db, "12345", &WorkspaceHistoryQuery::default()).unwrap_err().status,
        StatusCode::NOT_FOUND
    );
}

// ── thumbnail, pin, forget, history ────────────────────────────────────────

#[test]
fn thumbnails_pins_forget_and_history() {
    let fixture = Fixture::new();
    let work = fixture.work();
    let project = work.join("wall.fms");
    write_project(&project, "pid-wall", true);
    let script = work.join("a.py");
    write_script(&script, "import fullmag\n");
    let project_item = add(&fixture, &project);
    let script_item = add(&fixture, &script);

    let thumbnail = thumbnail_at(&fixture.db, &project_item.id).unwrap();
    assert_eq!(thumbnail.png, PNG.to_vec());
    assert_eq!(thumbnail.sha256.len(), 64);
    assert_eq!(thumbnail_at(&fixture.db, &script_item.id).unwrap_err().status, StatusCode::NOT_FOUND);

    let pinned = pin_item_at(&fixture.db, &script_item.id, true).unwrap();
    assert!(pinned.pinned);
    let list = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert_eq!(list.items[0].id, script_item.id, "pinned items come first");
    assert!(!pin_item_at(&fixture.db, &script_item.id, false).unwrap().pinned);

    let history = history_at(&fixture.db, &script_item.id, &WorkspaceHistoryQuery::default()).unwrap();
    let kinds: Vec<&str> = history.events.iter().map(|event| event.kind.as_str()).collect();
    assert_eq!(kinds, vec!["unpin", "pin", "import"]);
    assert!(history.events.iter().all(|event| event.actor == "web"));
    let limited = history_at(&fixture.db, &script_item.id, &WorkspaceHistoryQuery { limit: Some(1) }).unwrap();
    assert_eq!(limited.events.len(), 1);

    let forgotten = forget_item_at(&fixture.db, &script_item.id).unwrap();
    assert!(forgotten.forgotten);
    assert_eq!(get_item_at(&fixture.db, &script_item.id).unwrap_err().status, StatusCode::NOT_FOUND);
    let list = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert_eq!(list.items.len(), 1);
    assert!(script.exists(), "forgetting never touches the file");
    // Adding it again brings it back.
    let back = add(&fixture, &script);
    assert_eq!(back.id, script_item.id);
    assert_eq!(list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap().items.len(), 2);
}

// ── roots, scan, add ───────────────────────────────────────────────────────

fn root(path: &Path) -> WorkspaceRoot {
    WorkspaceRoot {
        path: path.display().to_string(),
        kinds: Vec::new(),
        recursive: true,
        enabled: true,
    }
}

#[test]
fn roots_are_validated_stored_and_scanned() {
    let fixture = Fixture::new();
    let work = fixture.work();
    write_script(&work.join("a.py"), "import fullmag\n");
    write_script(&work.join("sub/b.py"), "import fullmag\n");
    write_script(&work.join("plain.py"), "print(1)\n");
    write_project(&work.join("p.fms"), "pid-p", false);
    write_results(&work.join("r.zarr"), None);

    assert_eq!(roots_at(&fixture.db).unwrap().source, WorkspaceRootsSource::None);
    for bad in [
        WorkspaceRoot { path: "relative/dir".into(), ..root(&work) },
        WorkspaceRoot { path: fixture.dir.path().join("nope").display().to_string(), ..root(&work) },
        WorkspaceRoot { path: format!("{}/../work", work.display()), ..root(&work) },
        WorkspaceRoot { path: work.join("a.py").display().to_string(), ..root(&work) },
    ] {
        assert_eq!(
            put_roots_at(&fixture.db, &[bad]).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }
    assert!(validate_roots(&vec![root(&work); 65]).is_err());

    // Duplicates collapse; the stored path is the normalised spelling.
    let saved = put_roots_at(&fixture.db, &[root(&work), root(&work)]).unwrap();
    assert_eq!(saved.roots.len(), 1);
    assert_eq!(saved.source, WorkspaceRootsSource::Configured);
    assert!(!saved.roots[0].path.starts_with(r"\\?\"));
    assert_eq!(roots_at(&fixture.db).unwrap().roots.len(), 1);

    let report = scan_at(&fixture.db, None, &ScanOptions::default()).unwrap();
    assert_eq!(report.added, 4, "{report:?}");
    assert!(report.warnings.is_empty());
    let all = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert_eq!(all.items.len(), 4);
    assert!(all.items.iter().all(|item| item.use_count == 0));

    let second = scan_at(&fixture.db, None, &ScanOptions::default()).unwrap();
    assert_eq!((second.added, second.updated), (0, 4));

    // An explicit root list is scanned once and not saved.
    let other = Fixture::new();
    let one_off = scan_at(&other.db, Some(&[root(&work)]), &ScanOptions::default()).unwrap();
    assert_eq!(one_off.added, 4);
    assert_eq!(roots_at(&other.db).unwrap().source, WorkspaceRootsSource::None);

    // Clearing the roots is allowed.
    let cleared = put_roots_at(&fixture.db, &[]).unwrap();
    assert_eq!(cleared.source, WorkspaceRootsSource::None);
}

#[test]
fn project_roots_the_desktop_host_scanned_are_offered_until_roots_are_saved() {
    let fixture = Fixture::new();
    let work = fixture.work();
    write_project(&work.join("p.fms"), "pid-p", false);
    {
        let (workspace, _) = fullmag_workspace::Workspace::open(&fixture.db).unwrap();
        workspace
            .set_kv(
                "recent_scanned_locations",
                &json!([{"path": work.display().to_string(), "recursive": true}]),
            )
            .unwrap();
    }
    let roots = roots_at(&fixture.db).unwrap();
    assert_eq!(roots.source, WorkspaceRootsSource::Legacy);
    assert_eq!(roots.roots[0].kinds, vec![WorkspaceItemKind::Project]);
    let report = scan_at(&fixture.db, None, &ScanOptions::default()).unwrap();
    assert_eq!(report.added, 1);
}

#[test]
fn adding_a_path_validates_kind_and_shape() {
    let fixture = Fixture::new();
    let work = fixture.work();
    let script = work.join("a.py");
    write_script(&script, "x = 1\n");
    write_script(&work.join("notes.txt"), "x");
    let request = |path: String, kind: Option<WorkspaceItemKind>| WorkspaceAddRequest { path, kind };
    for (path, kind) in [
        ("relative.py".to_string(), None),
        (work.join("notes.txt").display().to_string(), None),
        (work.join("missing.py").display().to_string(), None),
        (work.display().to_string(), None),
        (script.display().to_string(), Some(WorkspaceItemKind::Project)),
        (format!("{}/../work/a.py", work.display()), None),
    ] {
        let error = add_item_at(&fixture.db, &request(path.clone(), kind)).unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST, "{path}: {}", error.message);
    }
    // A script that does not import fullmag can still be added explicitly.
    let item = add_item_at(&fixture.db, &request(script.display().to_string(), Some(WorkspaceItemKind::Script))).unwrap();
    assert_eq!(item.kind, WorkspaceItemKind::Script);
    assert_eq!(item.use_count, 1);
    let again = add_item_at(&fixture.db, &request(script.display().to_string(), None)).unwrap();
    assert_eq!((again.id.as_str(), again.use_count), (item.id.as_str(), 2));
}

#[test]
fn a_database_from_a_newer_schema_lists_but_refuses_writes() {
    let fixture = Fixture::new();
    let work = fixture.work();
    let script = work.join("a.py");
    write_script(&script, "import fullmag\n");
    let item = add(&fixture, &script);
    {
        let conn = rusqlite::Connection::open(&fixture.db).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
    }
    let list = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.outcome.state, WorkspaceOpenState::ReadOnlyNewerSchema);
    assert!(list.outcome.detail.as_deref().unwrap().contains("99"));
    assert!(get_item_at(&fixture.db, &item.id).is_ok(), "reading a detail still works");
    for error in [
        pin_item_at(&fixture.db, &item.id, true).unwrap_err(),
        forget_item_at(&fixture.db, &item.id).unwrap_err(),
        put_roots_at(&fixture.db, &[]).unwrap_err(),
        scan_at(&fixture.db, None, &ScanOptions::default()).unwrap_err(),
        add_item_at(&fixture.db, &WorkspaceAddRequest { path: script.display().to_string(), kind: None }).unwrap_err(),
    ] {
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some("workspace_read_only"));
    }
}

#[test]
fn a_damaged_database_is_quarantined_and_reported() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.db.parent().unwrap()).unwrap();
    fs::write(&fixture.db, b"this is not sqlite").unwrap();
    let list = list_items_at(&fixture.db, &WorkspaceItemsQuery::default()).unwrap();
    assert!(list.items.is_empty());
    assert_eq!(list.outcome.state, WorkspaceOpenState::Quarantined);
}

// ── router level ───────────────────────────────────────────────────────────

async fn call(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
    extra: &[(&str, &str)],
) -> axum::response::Response {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    let request = match body {
        Some(value) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(value.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    app.clone().oneshot(request).await.unwrap()
}

#[tokio::test]
async fn the_routes_serve_the_workspace_over_http_with_the_documented_status_codes() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    let work = fixture.work();
    std::env::set_var("FULLMAG_STATE_DIR", fixture.dir.path().join("state"));
    let project = work.join("wall.fms");
    write_project(&project, "pid-wall", true);
    let script = work.join("wall.py");
    write_script(&script, "import fullmag\n");
    let app = build_v2_router().with_state(test_app_state());

    let empty = call(&app, Method::GET, "/v2/workspace/items", None, &[]).await;
    assert_eq!(empty.status(), StatusCode::OK);
    let body = body_json(empty).await;
    assert_eq!(body["items"], json!([]));
    assert_eq!(body["outcome"]["state"], "created");

    // Roots and scan, with and without a body.
    let roots = call(
        &app,
        Method::PUT,
        "/v2/workspace/roots",
        Some(json!({"roots": [{"path": work.display().to_string(), "kinds": ["project", "script"]}]})),
        &[],
    )
    .await;
    assert_eq!(roots.status(), StatusCode::OK);
    let scan = call(&app, Method::POST, "/v2/workspace/scan", None, &[]).await;
    assert_eq!(scan.status(), StatusCode::OK);
    let report = body_json(scan).await;
    assert_eq!(report["added"], 2);
    assert_eq!(report["warnings"], json!([]));
    let bad_scan = call(&app, Method::POST, "/v2/workspace/scan", Some(json!({"roots": "x"})), &[]).await;
    assert_eq!(bad_scan.status(), StatusCode::BAD_REQUEST);

    let list = body_json(call(&app, Method::GET, "/v2/workspace/items?kind=project", None, &[]).await).await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let project_id = list["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(list["items"][0]["has_thumbnail"], true);

    let detail = call(&app, Method::GET, &format!("/v2/workspace/items/{project_id}"), None, &[]).await;
    assert_eq!(detail.status(), StatusCode::OK);
    let detail = body_json(detail).await;
    assert_eq!(detail["detail"]["kind"], "project");
    assert_eq!(detail["detail"]["project_id"], "pid-wall");
    assert!(detail["events"].is_array() && detail["linked_results"].is_array());

    // Thumbnail: PNG bytes, ETag, 304 on a repeat.
    let uri = format!("/v2/workspace/items/{project_id}/thumbnail");
    let png = call(&app, Method::GET, &uri, None, &[]).await;
    assert_eq!(png.status(), StatusCode::OK);
    assert_eq!(png.headers()[header::CONTENT_TYPE], "image/png");
    let etag = png.headers()[header::ETAG].to_str().unwrap().to_string();
    assert_eq!(body_bytes(png).await, PNG.to_vec());
    let cached = call(&app, Method::GET, &uri, None, &[("if-none-match", etag.as_str())]).await;
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(cached.headers()[header::ETAG].to_str().unwrap(), etag);
    let stale = call(&app, Method::GET, &uri, None, &[("if-none-match", "\"other\"")]).await;
    assert_eq!(stale.status(), StatusCode::OK);

    // Pin, history, forget.
    let pinned = call(&app, Method::POST, &format!("/v2/workspace/items/{project_id}/pin"), Some(json!({"pinned": true})), &[]).await;
    assert_eq!(pinned.status(), StatusCode::OK);
    assert_eq!(body_json(pinned).await["pinned"], true);
    let history = body_json(call(&app, Method::GET, &format!("/v2/workspace/items/{project_id}/history?limit=1"), None, &[]).await).await;
    assert_eq!(history["events"][0]["kind"], "pin");
    let forgotten = call(&app, Method::POST, &format!("/v2/workspace/items/{project_id}/forget"), None, &[]).await;
    assert_eq!(forgotten.status(), StatusCode::OK);
    let gone = call(&app, Method::GET, &format!("/v2/workspace/items/{project_id}"), None, &[]).await;
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    let bad = call(&app, Method::GET, "/v2/workspace/items/not-a-number", None, &[]).await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);

    // Add one path; a bad one is a 400.
    let added = call(&app, Method::POST, "/v2/workspace/items", Some(json!({"path": project.display().to_string(), "kind": "project"})), &[]).await;
    assert_eq!(added.status(), StatusCode::OK);
    let bad_add = call(&app, Method::POST, "/v2/workspace/items", Some(json!({"path": "relative.fms"})), &[]).await;
    assert_eq!(bad_add.status(), StatusCode::BAD_REQUEST);

    std::env::remove_var("FULLMAG_STATE_DIR");
}

#[test]
fn the_openapi_document_describes_every_workspace_route_and_its_detail_union() {
    let document = crate::openapi_v2::openapi_json();
    let paths = document["paths"].as_object().unwrap();
    for (path, methods) in [
        ("/v2/workspace/items", vec!["get", "post"]),
        ("/v2/workspace/items/{id}", vec!["get"]),
        ("/v2/workspace/items/{id}/thumbnail", vec!["get"]),
        ("/v2/workspace/items/{id}/pin", vec!["post"]),
        ("/v2/workspace/items/{id}/forget", vec!["post"]),
        ("/v2/workspace/items/{id}/history", vec!["get"]),
        ("/v2/workspace/roots", vec!["get", "put"]),
        ("/v2/workspace/scan", vec!["post"]),
    ] {
        for method in methods {
            assert!(paths[path][method].is_object(), "{method} {path}");
        }
    }
    let schemas = &document["components"]["schemas"];
    for name in ["WorkspaceItem", "WorkspaceItemList", "WorkspaceItemDetail", "ItemDetail", "ProjectDetail", "ScriptDetail", "ResultDetail", "WorkspaceScanReport"] {
        assert!(schemas[name].is_object(), "{name}");
    }
    // The detail is a union tagged by `kind`.
    let detail = &schemas["ItemDetail"];
    assert!(detail["oneOf"].is_array(), "{detail}");
    assert_eq!(detail["oneOf"].as_array().unwrap().len(), 3);
    // Binary thumbnail response.
    assert!(paths["/v2/workspace/items/{id}/thumbnail"]["get"]["responses"]["200"]["content"]["image/png"].is_object());
}
