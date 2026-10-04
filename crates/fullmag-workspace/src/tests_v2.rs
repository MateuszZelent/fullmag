//! Tests of schema version 2 (thumbnails) and of scanned files (`observe`).

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::json;

use crate::*;

const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn open(dir: &Path) -> (Workspace, OpenOutcome) {
    Workspace::open(dir.join("workspace.db")).expect("open workspace")
}

fn touch(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, text).unwrap();
    path
}

fn event(kind: ItemKind, path: &Path, what: EventKind) -> RecordEvent {
    RecordEvent::new(kind, path, what, Actor::Desktop)
}

fn tiny_png(tail: &[u8]) -> Vec<u8> {
    let mut png = PNG_SIGNATURE.to_vec();
    png.extend_from_slice(tail);
    png
}

fn table_names(path: &Path) -> Vec<String> {
    let conn = Connection::open(path).unwrap();
    let mut statement = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap();
    let rows = statement.query_map([], |r| r.get::<_, String>(0)).unwrap();
    rows.map(|row| row.unwrap()).collect()
}

#[test]
fn a_version_1_database_migrates_to_the_current_schema_keeping_its_items() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    let script = touch(dir.path(), "old.py", "x = 1\n");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(SCHEMA_V1_SQL).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO items (kind, path, path_key, name, first_seen_at, last_used_at, use_count) \
             VALUES ('script', ?1, ?1, 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 3)",
            [script.display().to_string()],
        )
        .unwrap();
    }
    assert!(!table_names(&db).iter().any(|n| n == "thumbnails"));

    let (workspace, outcome) = Workspace::open(&db).unwrap();
    assert_eq!(
        outcome,
        OpenOutcome::Migrated {
            from: 1,
            to: SCHEMA_VERSION
        }
    );
    let items = workspace.list(&Query::default()).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].use_count, 3);
    assert!(workspace.get_thumbnail(items[0].id).unwrap().is_none());
    drop(workspace);
    assert!(table_names(&db).iter().any(|n| n == "thumbnails"));
}

#[test]
fn thumbnails_round_trip_replace_and_remove() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let project = touch(dir.path(), "p.fms", "archive");
    let id = workspace
        .record(&event(ItemKind::Project, &project, EventKind::Open))
        .unwrap()
        .item_id;
    assert!(workspace.get_thumbnail(id).unwrap().is_none());

    let first = tiny_png(b"one");
    workspace.set_thumbnail(id, DIGEST_A, &first).unwrap();
    let stored = workspace.get_thumbnail(&project).unwrap().unwrap();
    assert_eq!(stored.png, first);
    assert_eq!(stored.sha256, DIGEST_A);

    // Another digest replaces the row; the same digest leaves it alone.
    let second = tiny_png(b"two");
    workspace.set_thumbnail(id, DIGEST_B, &second).unwrap();
    assert_eq!(workspace.get_thumbnail(id).unwrap().unwrap().png, second);
    workspace
        .set_thumbnail(id, DIGEST_B, &tiny_png(b"ignored"))
        .unwrap();
    assert_eq!(workspace.get_thumbnail(id).unwrap().unwrap().png, second);

    workspace.remove_thumbnail(id).unwrap();
    assert!(workspace.get_thumbnail(id).unwrap().is_none());
    assert!(workspace.get_thumbnail(987_654).unwrap().is_none());
}

#[test]
fn thumbnails_are_validated_and_capped() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let project = touch(dir.path(), "p.fms", "archive");
    let id = workspace
        .record(&event(ItemKind::Project, &project, EventKind::Open))
        .unwrap()
        .item_id;

    assert!(matches!(
        workspace.set_thumbnail(id, DIGEST_A, b"GIF89a...."),
        Err(WorkspaceError::Invalid(_))
    ));
    let mut huge = tiny_png(&[]);
    huge.resize(MAX_THUMBNAIL_BYTES + 1, 0);
    assert!(matches!(
        workspace.set_thumbnail(id, DIGEST_A, &huge),
        Err(WorkspaceError::Invalid(_))
    ));
    huge.truncate(MAX_THUMBNAIL_BYTES);
    workspace.set_thumbnail(id, DIGEST_A, &huge).unwrap();
    assert!(matches!(
        workspace.set_thumbnail(id, "not-a-digest", &tiny_png(b"x")),
        Err(WorkspaceError::Invalid(_))
    ));
    assert!(matches!(
        workspace.set_thumbnail(424_242, DIGEST_A, &tiny_png(b"x")),
        Err(WorkspaceError::NotFound(_))
    ));
}

#[test]
fn a_read_only_database_refuses_thumbnail_writes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    let project = touch(dir.path(), "p.fms", "archive");
    let id = {
        let (workspace, _) = Workspace::open(&db).unwrap();
        workspace
            .record(&event(ItemKind::Project, &project, EventKind::Open))
            .unwrap()
            .item_id
    };
    Connection::open(&db)
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    let (workspace, _) = Workspace::open(&db).unwrap();
    assert!(matches!(
        workspace.set_thumbnail(id, DIGEST_A, &tiny_png(b"x")),
        Err(WorkspaceError::ReadOnly { .. })
    ));
    assert!(workspace.get_thumbnail(id).unwrap().is_none());
}

#[test]
fn observing_a_file_creates_an_unused_item_and_never_touches_counters() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let project = touch(dir.path(), "scan.fms", "archive");

    let mut seen = SeenItem::new(ItemKind::Project, &project);
    seen.name = Some("Scanned".into());
    seen.project_id = Some("pid-1".into());
    seen.meta_patch = Some(json!({"solver": "fem", "revision": 3}));
    let receipt = workspace.observe(&seen).unwrap();
    assert!(receipt.created);

    let item = workspace.find(&project).unwrap().unwrap();
    assert_eq!(item.use_count, 0);
    assert_eq!(item.name, "Scanned");
    assert_eq!(item.meta["solver"], "fem");
    assert_eq!(
        Some(item.last_used_at.clone()),
        item.modified_at.clone(),
        "a scanned file is last used when it was last modified"
    );
    assert_eq!(
        workspace.history(&project, 5).unwrap()[0].kind,
        EventKind::Import
    );

    // A pin and a use survive a second scan, which only refreshes what it knows.
    workspace.pin(&project, true, Actor::Desktop).unwrap();
    workspace
        .record(&event(ItemKind::Project, &project, EventKind::Open))
        .unwrap();
    seen.status = ItemStatus::Migrate;
    seen.meta_patch = Some(json!({"revision": 4}));
    let again = workspace.observe(&seen).unwrap();
    assert!(!again.created);
    let item = workspace.find(&project).unwrap().unwrap();
    assert_eq!(item.use_count, 1);
    assert!(item.pinned);
    assert_eq!(item.status, ItemStatus::Migrate);
    assert_eq!(item.meta["revision"], 4);
    assert_eq!(item.meta["solver"], "fem", "unmentioned fields are kept");
}

#[test]
fn observing_does_not_resurrect_a_forgotten_item_and_flags_a_vanished_file() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let project = touch(dir.path(), "gone.fms", "archive");
    let seen = SeenItem::new(ItemKind::Project, &project);
    workspace.observe(&seen).unwrap();
    workspace.forget(&project, Actor::Desktop).unwrap();
    workspace.observe(&seen).unwrap();
    assert!(workspace.list(&Query::default()).unwrap().is_empty());

    fs::remove_file(&project).unwrap();
    workspace.observe(&seen).unwrap();
    let item = workspace.find(&project).unwrap().unwrap();
    assert_eq!(item.status, ItemStatus::Missing);
    assert!(item.forgotten);
}
