//! Tests of schema version 3: result items, `edit` events, scan roots.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::json;

use crate::*;

fn open(dir: &Path) -> (Workspace, OpenOutcome) {
    Workspace::open(dir.join("workspace.db")).expect("open workspace")
}

fn touch(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, text).unwrap();
    path
}

#[test]
fn a_version_2_database_migrates_to_3_keeping_rows_events_and_thumbnails() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    let script = touch(dir.path(), "old.py", "x = 1\n");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(SCHEMA_V1_SQL).unwrap();
        conn.execute_batch(SCHEMA_V2_SQL).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "INSERT INTO items (kind, path, path_key, name, first_seen_at, last_used_at, use_count, pinned) \
             VALUES ('script', ?1, ?1, 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 3, 1)",
            [script.display().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO events (item_id, at, kind, actor, detail) \
             VALUES (1, '2026-01-01T00:00:00.000Z', 'open', 'cli', '{\"a\":1}')",
            [],
        )
        .unwrap();
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"tail");
        conn.execute(
            "INSERT INTO thumbnails (item_id, sha256, png) VALUES (1, 'abc', ?1)",
            [png],
        )
        .unwrap();
    }

    let (workspace, outcome) = Workspace::open(&db).unwrap();
    assert_eq!(outcome, OpenOutcome::Migrated { from: 2, to: 3 });
    let items = workspace.list(&Query::default()).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!((items[0].use_count, items[0].pinned), (3, true));
    let history = workspace.history(items[0].id, 10).unwrap();
    assert_eq!(history.len(), 1, "events survive the table rebuild");
    assert_eq!(history[0].detail, json!({"a": 1}));
    assert!(workspace.get_thumbnail(items[0].id).unwrap().is_some());

    // Foreign keys are enforced again after the migration: deleting the item
    // cascades to its events and thumbnail.
    let enforced: i64 = workspace
        .conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(enforced, 1);

    // The new kind and event are accepted.
    let result_dir = dir.path().join("run.zarr");
    fs::create_dir(&result_dir).unwrap();
    workspace
        .observe(&SeenItem::new(ItemKind::Result, &result_dir))
        .unwrap();
}

#[test]
fn result_items_are_kept_out_of_the_default_list_but_listed_on_request() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "a.py", "import fullmag\n");
    let results = dir.path().join("a.zarr");
    fs::create_dir(&results).unwrap();
    workspace
        .record(&RecordEvent::new(
            ItemKind::Script,
            &script,
            EventKind::Open,
            Actor::Cli,
        ))
        .unwrap();
    let mut seen = SeenItem::new(ItemKind::Result, &results);
    seen.actor = Actor::Web;
    seen.meta_patch = Some(json!({
        "source": {"kind": "script", "path": script.display().to_string(), "sha256": "ab"}
    }));
    let receipt = workspace.observe(&seen).unwrap();
    assert!(receipt.created);

    let default = workspace.list(&Query::default()).unwrap();
    assert_eq!(default.len(), 1);
    assert_eq!(default[0].kind, ItemKind::Script);

    let all = workspace
        .list(&Query {
            include_results: true,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(all.len(), 2);

    let only = workspace
        .list(&Query {
            kind: Some(ItemKind::Result),
            ..Query::default()
        })
        .unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].meta["source"]["sha256"], "ab");
    assert_eq!(only[0].use_count, 0);
    let history = workspace.history(only[0].id, 10).unwrap();
    assert_eq!(history[0].kind, EventKind::Import);
    assert_eq!(history[0].actor, Actor::Web);

    // Forgotten stays forgotten after a new observation.
    workspace.forget(only[0].id, Actor::Web).unwrap();
    workspace.observe(&seen).unwrap();
    assert!(workspace
        .list(&Query {
            kind: Some(ItemKind::Result),
            ..Query::default()
        })
        .unwrap()
        .is_empty());
}

#[test]
fn a_changed_script_hash_records_one_edit_event_with_before_and_after() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "wall.py", "import fullmag\nx = 1\n");
    let id = workspace
        .record(&RecordEvent::new(
            ItemKind::Script,
            &script,
            EventKind::Open,
            Actor::Desktop,
        ))
        .unwrap()
        .item_id;

    // First observation: digest stored, no edit event.
    let first = workspace.observe_file(id, Actor::Web).unwrap();
    assert!(!first.edited);
    assert_eq!(first.lines, 2);
    let item = workspace.find(id).unwrap().unwrap();
    assert_eq!(item.meta["sha256"], first.sha256);
    assert_eq!(item.meta["bytes"], 21);
    assert_eq!(workspace.history(id, 10).unwrap().len(), 1);

    // Unchanged: nothing recorded.
    assert!(!workspace.observe_file(id, Actor::Web).unwrap().edited);
    assert_eq!(workspace.history(id, 10).unwrap().len(), 1);

    // Edited: one edit event, use count untouched.
    fs::write(&script, "import fullmag\nx = 2\ny = 3\n").unwrap();
    let second = workspace.observe_file(id, Actor::Web).unwrap();
    assert!(second.edited);
    let history = workspace.history(id, 10).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].kind, EventKind::Edit);
    assert_eq!(history[0].actor, Actor::Web);
    assert_eq!(history[0].detail["sha256_before"], first.sha256);
    assert_eq!(history[0].detail["sha256_after"], second.sha256);
    assert_eq!(history[0].detail["lines_before"], 2);
    assert_eq!(history[0].detail["lines_after"], 3);
    assert_eq!(history[0].detail["bytes_before"], 21);
    assert_eq!(history[0].detail["bytes_after"], 27);
    let item = workspace.find(id).unwrap().unwrap();
    assert_eq!(item.use_count, 1);
    assert_eq!(item.meta["sha256"], second.sha256);

    // The file text is never stored.
    let dump = serde_json::to_string(&history).unwrap() + &item.meta.to_string();
    assert!(!dump.contains("x = 2"));
}

#[test]
fn refresh_file_state_observes_scripts_whose_file_changed() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "a.py", "x = 1\n");
    let id = workspace
        .record(&RecordEvent::new(
            ItemKind::Script,
            &script,
            EventKind::Open,
            Actor::Desktop,
        ))
        .unwrap()
        .item_id;
    // Never hashed: the first refresh stores the digest without an edit event.
    workspace.refresh_file_state(id).unwrap();
    assert_eq!(workspace.history(id, 10).unwrap().len(), 1);
    assert!(workspace.find(id).unwrap().unwrap().meta["sha256"].is_string());

    fs::write(&script, "x = 12345\n").unwrap();
    workspace.refresh_file_state_as(id, Actor::Cli).unwrap();
    let history = workspace.history(id, 10).unwrap();
    assert_eq!(history[0].kind, EventKind::Edit);
    assert_eq!(history[0].actor, Actor::Cli);
}

#[test]
fn scan_roots_round_trip_with_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    assert!(workspace.roots().unwrap().is_empty());
    let roots = vec![
        WorkspaceRoot {
            path: dir.path().display().to_string(),
            kinds: vec![ItemKind::Script, ItemKind::Result],
            recursive: false,
            enabled: true,
        },
        WorkspaceRoot {
            path: "C:/other".into(),
            kinds: Vec::new(),
            recursive: true,
            enabled: false,
        },
    ];
    workspace.set_roots(&roots).unwrap();
    assert_eq!(workspace.roots().unwrap(), roots);
    // A hand-written entry that omits the optional fields still reads.
    workspace
        .set_kv(WORKSPACE_ROOTS_KEY, &json!([{"path": "D:/x"}]))
        .unwrap();
    let read = workspace.roots().unwrap();
    assert_eq!(read.len(), 1);
    assert!(read[0].recursive && read[0].enabled && read[0].kinds.is_empty());
}

#[test]
fn hash_file_counts_lines_like_str_lines() {
    let dir = tempfile::tempdir().unwrap();
    for (text, lines) in [("", 0), ("a", 1), ("a\n", 1), ("a\nb", 2), ("\n\n", 2)] {
        let path = touch(dir.path(), "t.txt", text);
        assert_eq!(hash_file(&path).unwrap().lines, lines, "{text:?}");
        assert_eq!(text.lines().count() as u64, lines);
    }
}
