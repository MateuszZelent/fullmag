//! Behavioural tests of the workspace database, one per gate of spec section 10.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::*;

fn at(seconds: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_700_000_000 + seconds)
}

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

fn master_rows(path: &Path) -> Vec<(String, String, String, Option<String>)> {
    let conn = Connection::open(path).unwrap();
    let mut statement = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap();
    let rows = statement
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn paths_of(items: &[Item]) -> Vec<String> {
    items.iter().map(|i| i.name.clone()).collect()
}

// ── schema ──────────────────────────────────────────────────────────────

#[test]
fn schema_is_identical_on_create_reopen_and_migration_from_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    let created = dir.path().join("created.db");
    let (workspace, outcome) = Workspace::open(&created).unwrap();
    assert_eq!(outcome, OpenOutcome::Created);
    drop(workspace);
    let first = master_rows(&created);
    assert!(first.iter().any(|r| r.1 == "items"));
    assert!(first.iter().any(|r| r.1 == "events"));
    assert!(first.iter().any(|r| r.1 == "kv"));
    assert!(first.iter().any(|r| r.1 == "items_recent"));
    assert!(first.iter().any(|r| r.1 == "items_project_id"));
    assert!(first.iter().any(|r| r.1 == "events_item"));

    let (reopened, outcome) = Workspace::open(&created).unwrap();
    assert_eq!(outcome, OpenOutcome::Ready);
    drop(reopened);
    assert_eq!(master_rows(&created), first);

    // An existing but empty file migrates to the same schema.
    let empty = dir.path().join("empty.db");
    fs::File::create(&empty).unwrap();
    let (workspace, outcome) = Workspace::open(&empty).unwrap();
    assert_eq!(outcome, OpenOutcome::Created);
    drop(workspace);
    assert_eq!(master_rows(&empty), first);

    let conn = Connection::open(&created).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, i64::from(SCHEMA_VERSION));
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

// ── concurrency ─────────────────────────────────────────────────────────

#[test]
fn eight_connections_recording_concurrently_lose_no_use_count() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    let script = touch(dir.path(), "shared.py", "import fullmag\n");

    // No pre-created database: the threads also race on creation and migration.
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let db = db.clone();
            let script = script.clone();
            std::thread::spawn(move || {
                let (workspace, _) = Workspace::open(&db).expect("open");
                for _ in 0..200 {
                    workspace
                        .record(&RecordEvent::new(
                            ItemKind::Script,
                            &script,
                            EventKind::Open,
                            Actor::Cli,
                        ))
                        .expect("record must not surface a lock error");
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().expect("thread panicked");
    }

    let (workspace, _) = Workspace::open(&db).unwrap();
    let items = workspace.list(&Query::default()).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].use_count, 1600);
    assert_eq!(
        workspace.history(&script, 10_000).unwrap().len(),
        MAX_EVENTS_PER_ITEM
    );
}

// ── damage ──────────────────────────────────────────────────────────────

#[test]
fn garbage_file_is_quarantined_and_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    fs::write(
        &db,
        b"this is not a sqlite database at all, just text".repeat(50),
    )
    .unwrap();

    let (workspace, outcome) = Workspace::open(&db).unwrap();
    let OpenOutcome::Quarantined { backup, reason } = outcome else {
        panic!("expected quarantine, got {outcome:?}");
    };
    assert!(!reason.is_empty());
    assert!(backup
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("workspace.db.corrupt-"));
    assert!(backup.exists(), "the damaged file is kept for the user");
    // The fresh database works.
    let script = touch(dir.path(), "a.py", "x = 1\n");
    workspace
        .record(&event(ItemKind::Script, &script, EventKind::Open))
        .unwrap();
    assert_eq!(workspace.list(&Query::default()).unwrap().len(), 1);
}

#[test]
fn truncated_database_is_quarantined_and_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    {
        let (workspace, _) = Workspace::open(&db).unwrap();
        for i in 0..200 {
            let path = dir
                .path()
                .join(format!("script-{i:03}-{}.py", "x".repeat(60)));
            workspace
                .record(&event(ItemKind::Script, &path, EventKind::Open))
                .unwrap();
        }
    }
    let size = fs::metadata(&db).unwrap().len();
    assert!(size > 12_000, "fixture must span several pages, got {size}");
    fs::OpenOptions::new()
        .write(true)
        .open(&db)
        .unwrap()
        .set_len(6000)
        .unwrap();

    let (workspace, outcome) = Workspace::open(&db).unwrap();
    assert!(
        matches!(outcome, OpenOutcome::Quarantined { .. }),
        "got {outcome:?}"
    );
    assert!(workspace.list(&Query::default()).unwrap().is_empty());
}

#[test]
fn newer_schema_opens_read_only_and_refuses_writes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    let script = touch(dir.path(), "a.py", "x = 1\n");
    {
        let (workspace, _) = Workspace::open(&db).unwrap();
        workspace
            .record(&event(ItemKind::Script, &script, EventKind::Open))
            .unwrap();
    }
    Connection::open(&db)
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();

    let (workspace, outcome) = Workspace::open(&db).unwrap();
    assert_eq!(
        outcome,
        OpenOutcome::ReadOnlyNewerSchema {
            found: 99,
            supported: SCHEMA_VERSION
        }
    );
    assert_eq!(workspace.read_only_reason(), Some((99, SCHEMA_VERSION)));
    // Reading still works ...
    assert_eq!(workspace.list(&Query::default()).unwrap().len(), 1);
    // ... writing does not, with a typed error, and nothing is stored.
    let error = workspace
        .record(&event(ItemKind::Script, &script, EventKind::Open))
        .unwrap_err();
    assert!(matches!(
        error,
        WorkspaceError::ReadOnly {
            found: 99,
            supported: 1
        }
    ));
    assert!(!workspace.record_best_effort(&event(ItemKind::Script, &script, EventKind::Open)));
    assert!(matches!(
        workspace.set_kv("k", &json!(1)),
        Err(WorkspaceError::ReadOnly { .. })
    ));
    assert_eq!(workspace.list(&Query::default()).unwrap()[0].use_count, 1);
    // The file keeps its newer version.
    drop(workspace);
    let version: i64 = Connection::open(&db)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 99);
}

// ── identity ────────────────────────────────────────────────────────────

#[test]
fn two_spellings_of_one_path_are_one_item() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "Wall.py", "x = 1\n");
    let roundabout = dir.path().join("sub").join("..").join("Wall.py");

    let first = workspace
        .record(&event(ItemKind::Script, &script, EventKind::Open))
        .unwrap();
    let second = workspace
        .record(&event(ItemKind::Script, &roundabout, EventKind::Run))
        .unwrap();
    assert_eq!(first.item_id, second.item_id);
    assert!(first.created && !second.created);
    let items = workspace.list(&Query::default()).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].use_count, 2);
}

#[test]
fn path_case_is_ignored_only_where_the_platform_does() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "Case.py", "x = 1\n");
    let upper = script.with_file_name("CASE.PY");

    let a = workspace
        .record(&event(ItemKind::Script, &script, EventKind::Open))
        .unwrap();
    let b = workspace
        .record(&event(ItemKind::Script, &upper, EventKind::Open))
        .unwrap();
    if CASE_INSENSITIVE_PATHS {
        assert_eq!(a.item_id, b.item_id);
    } else {
        assert_ne!(a.item_id, b.item_id);
    }
}

#[test]
fn moved_project_keeps_its_row_but_a_copy_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let old = touch(dir.path(), "old.fms", "archive");
    let pid = "7b1f0c2e-9a44-4d1b-8f52-2c9e0a7d1101";

    let first = workspace
        .record(
            &event(ItemKind::Project, &old, EventKind::Open)
                .with_project_id(pid)
                .with_name("Waveguide")
                .with_meta_patch(json!({"tags": ["yig"]})),
        )
        .unwrap();

    // A copy: the original still exists, so it is a second item.
    let copy = touch(dir.path(), "copy.fms", "archive");
    let copied = workspace
        .record(&event(ItemKind::Project, &copy, EventKind::Open).with_project_id(pid))
        .unwrap();
    assert_ne!(copied.item_id, first.item_id);
    assert!(!copied.repointed);

    // A move: the old path disappears, the project id re-points the row.
    let moved = dir.path().join("moved.fms");
    fs::rename(&old, &moved).unwrap();
    let after = workspace
        .record(&event(ItemKind::Project, &moved, EventKind::Open).with_project_id(pid))
        .unwrap();
    assert_eq!(after.item_id, first.item_id);
    assert!(after.repointed);
    let item = workspace.find(first.item_id).unwrap().unwrap();
    assert!(item.path.ends_with("moved.fms"));
    assert_eq!(item.name, "Waveguide");
    assert_eq!(item.use_count, 2);
    assert_eq!(item.meta["tags"], json!(["yig"]));
    assert_eq!(item.status, ItemStatus::Ready);
}

// ── recording semantics ─────────────────────────────────────────────────

#[test]
fn only_use_events_count_and_pin_forget_set_flags() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "a.py", "x = 1\n");
    for (i, what) in [
        EventKind::Create,
        EventKind::Open,
        EventKind::Save,
        EventKind::Run,
        EventKind::Import,
    ]
    .into_iter()
    .enumerate()
    {
        workspace
            .record_at(&event(ItemKind::Script, &script, what), at(i as u64))
            .unwrap();
    }
    let item = workspace.find(&script).unwrap().unwrap();
    assert_eq!(item.use_count, 5);
    assert_eq!(item.last_used_at, rfc3339_millis(at(4)));

    let pinned = workspace.pin(&script, true, Actor::Desktop).unwrap();
    assert!(pinned.pinned);
    assert_eq!(pinned.use_count, 5);
    assert_eq!(pinned.last_used_at, item.last_used_at);
    assert!(
        !workspace
            .pin(&script, false, Actor::Desktop)
            .unwrap()
            .pinned
    );

    workspace.pin(&script, true, Actor::Desktop).unwrap();
    let forgotten = workspace.forget(&script, Actor::Desktop).unwrap();
    assert!(forgotten.forgotten && !forgotten.pinned);
    assert!(workspace.list(&Query::default()).unwrap().is_empty());
    // The row and its history stay; using the file again brings it back.
    assert_eq!(workspace.history(&script, 100).unwrap().len(), 9);
    workspace
        .record(&event(ItemKind::Script, &script, EventKind::Open))
        .unwrap();
    assert_eq!(workspace.list(&Query::default()).unwrap().len(), 1);

    let kinds: Vec<EventKind> = workspace
        .history(&script, 3)
        .unwrap()
        .into_iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(kinds, [EventKind::Open, EventKind::Forget, EventKind::Pin]);
}

#[test]
fn meta_is_merged_and_unknown_fields_survive() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "a.py", "x = 1\n");
    workspace
        .record(
            &event(ItemKind::Script, &script, EventKind::Open)
                .with_meta_patch(json!({"lines": 1, "future_field": {"a": 1, "b": 2}})),
        )
        .unwrap();
    workspace
        .record(
            &event(ItemKind::Script, &script, EventKind::Run).with_meta_patch(json!({
                "lines": 9,
                "last_run": {"status": "ok"},
                "future_field": {"b": null, "c": 3}
            })),
        )
        .unwrap();
    let meta = workspace.find(&script).unwrap().unwrap().meta;
    assert_eq!(meta["lines"], 9);
    assert_eq!(meta["last_run"], json!({"status": "ok"}));
    assert_eq!(meta["future_field"], json!({"a": 1, "c": 3}));

    workspace
        .patch_meta(&script, &json!({"last_run": {"duration_seconds": 2.5}}))
        .unwrap();
    let item = workspace.find(&script).unwrap().unwrap();
    assert_eq!(item.use_count, 2, "patching meta does not count as use");
    assert_eq!(
        item.meta["last_run"],
        json!({"status": "ok", "duration_seconds": 2.5})
    );
}

#[test]
fn missing_files_are_flagged_and_refresh_restores_them() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "a.py", "x = 1\n");
    workspace
        .record(&event(ItemKind::Script, &script, EventKind::Open))
        .unwrap();
    let item = workspace.find(&script).unwrap().unwrap();
    assert_eq!(item.status, ItemStatus::Ready);
    assert_eq!(item.size_bytes, Some(6));
    assert!(item.modified_at.is_some());

    fs::remove_file(&script).unwrap();
    assert_eq!(
        workspace.refresh_file_state(&script).unwrap().status,
        ItemStatus::Missing
    );
    let hidden = Query {
        include_missing: false,
        ..Query::default()
    };
    assert!(workspace.list(&hidden).unwrap().is_empty());
    assert_eq!(workspace.list(&Query::default()).unwrap().len(), 1);

    fs::write(&script, "x = 12345\n").unwrap();
    let back = workspace.refresh_file_state(&script).unwrap();
    assert_eq!(back.status, ItemStatus::Ready);
    assert_eq!(back.size_bytes, Some(10));

    workspace.set_status(&script, ItemStatus::Failed).unwrap();
    assert_eq!(
        workspace.refresh_file_state(&script).unwrap().status,
        ItemStatus::Failed,
        "an explicit status survives while the file exists"
    );
}

#[test]
fn kv_round_trips_and_clear_history_keeps_items() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    assert_eq!(workspace.get_kv("sort").unwrap(), None);
    workspace.set_kv("sort", &json!({"by": "name"})).unwrap();
    workspace
        .set_kv("sort", &json!({"by": "use_count"}))
        .unwrap();
    assert_eq!(
        workspace.get_kv("sort").unwrap(),
        Some(json!({"by": "use_count"}))
    );
    workspace.remove_kv("sort").unwrap();
    assert_eq!(workspace.get_kv("sort").unwrap(), None);

    let script = touch(dir.path(), "a.py", "x = 1\n");
    workspace
        .record(
            &event(ItemKind::Script, &script, EventKind::Run).with_meta_patch(
                json!({"args": ["--x"], "last_run": {"status": "ok"}, "lines": 1}),
            ),
        )
        .unwrap();
    workspace.clear_history().unwrap();
    let item = workspace.find(&script).unwrap().unwrap();
    assert_eq!(item.use_count, 1);
    assert_eq!(item.meta, json!({"lines": 1}));
    assert!(workspace.history(&script, 10).unwrap().is_empty());
}

#[test]
fn unknown_item_is_a_typed_error() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    assert!(matches!(
        workspace.pin(Path::new("nope.py"), true, Actor::Cli),
        Err(WorkspaceError::NotFound(_))
    ));
    assert!(workspace.find(12345_i64).unwrap().is_none());
}

// ── queries ─────────────────────────────────────────────────────────────

fn seed(workspace: &Workspace, dir: &Path) {
    // name, kind, opens, last-open offset (s)
    let rows: [(&str, ItemKind, u32, u64); 5] = [
        ("alpha.fms", ItemKind::Project, 1, 50),
        ("Bravo.py", ItemKind::Script, 5, 10),
        ("charlie.fms", ItemKind::Project, 3, 40),
        ("delta.py", ItemKind::Script, 2, 30),
        ("echo.py", ItemKind::Script, 4, 20),
    ];
    for (name, kind, opens, last) in rows {
        let path = touch(dir, name, "content");
        for n in 0..opens {
            let when = if n + 1 == opens { last } else { n as u64 };
            workspace
                .record_at(
                    &RecordEvent::new(kind, &path, EventKind::Open, Actor::Desktop),
                    at(when),
                )
                .unwrap();
        }
    }
}

#[test]
fn sorts_apply_pinned_first_and_stable_tie_breaks() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    seed(&workspace, dir.path());
    let names = |sort| {
        paths_of(
            &workspace
                .list(&Query {
                    sort,
                    ..Query::default()
                })
                .unwrap(),
        )
    };
    assert_eq!(
        names(Sort::LastUsed),
        ["alpha", "charlie", "delta", "echo", "Bravo"]
    );
    // Case-insensitive: "Bravo" sorts between alpha and charlie.
    assert_eq!(
        names(Sort::Name),
        ["alpha", "Bravo", "charlie", "delta", "echo"]
    );
    assert_eq!(
        names(Sort::UseCount),
        ["Bravo", "echo", "charlie", "delta", "alpha"]
    );
    // All files were written in this test run; modified order is by mtime
    // with id as the tie-break, so just check it is a permutation.
    assert_eq!(names(Sort::Modified).len(), 5);

    workspace
        .pin(&dir.path().join("delta.py"), true, Actor::Desktop)
        .unwrap();
    assert_eq!(names(Sort::LastUsed)[0], "delta");
    assert_eq!(names(Sort::Name)[0], "delta");
    assert_eq!(names(Sort::UseCount)[0], "delta");
    assert_eq!(names(Sort::Name)[1], "alpha");

    let scripts = workspace
        .list(&Query {
            kind: Some(ItemKind::Script),
            ..Query::default()
        })
        .unwrap();
    assert_eq!(paths_of(&scripts), ["delta", "echo", "Bravo"]);
    let limited = workspace
        .list(&Query {
            limit: 2,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(limited.len(), 2);
}

#[test]
fn modified_sort_orders_by_mtime_with_unknown_last() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let a = touch(dir.path(), "a.py", "1");
    let b = touch(dir.path(), "b.py", "2");
    let ghost = dir.path().join("ghost.py");
    for (path, secs) in [(&a, 0), (&b, 1), (&ghost, 2)] {
        workspace
            .record_at(&event(ItemKind::Script, path, EventKind::Open), at(secs))
            .unwrap();
    }
    workspace
        .conn
        .execute(
            "UPDATE items SET modified_at = ?1 WHERE name = 'a'",
            ["2026-01-01T00:00:00.000Z"],
        )
        .unwrap();
    workspace
        .conn
        .execute(
            "UPDATE items SET modified_at = ?1 WHERE name = 'b'",
            ["2026-06-01T00:00:00.000Z"],
        )
        .unwrap();
    let items = workspace
        .list(&Query {
            sort: Sort::Modified,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(paths_of(&items), ["b", "a", "ghost"]);
}

#[test]
fn search_matches_name_path_and_authors_case_insensitively() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let nested = dir.path().join("Magnonics Lab");
    fs::create_dir(&nested).unwrap();
    let a = touch(&nested, "Spin-Wave.fms", "x");
    let b = touch(dir.path(), "other.py", "x");
    let c = touch(dir.path(), "Über.fms", "x");
    workspace
        .record(
            &event(ItemKind::Project, &a, EventKind::Open).with_meta_patch(
                json!({"authors": [{"name": "Mateusz Zelent", "role": "creator"}]}),
            ),
        )
        .unwrap();
    workspace
        .record(
            &event(ItemKind::Script, &b, EventKind::Open)
                .with_meta_patch(json!({"authors": ["Plain String"]})),
        )
        .unwrap();
    workspace
        .record(&event(ItemKind::Project, &c, EventKind::Open))
        .unwrap();

    let search = |term: &str| {
        paths_of(
            &workspace
                .list(&Query {
                    search: Some(term.to_string()),
                    sort: Sort::Name,
                    ..Query::default()
                })
                .unwrap(),
        )
    };
    assert_eq!(search("SPIN-wave"), ["Spin-Wave"]);
    assert_eq!(search("magnonics lab"), ["Spin-Wave"], "path match");
    assert_eq!(search("zelent"), ["Spin-Wave"], "author object");
    assert_eq!(search("plain str"), ["other"], "author string");
    assert_eq!(search("üBER"), ["Über"], "non-ASCII folding");
    assert!(search("nothing like this").is_empty());
    assert_eq!(search("  ").len(), 3, "blank search is no search");
    // LIKE wildcards are literals, not patterns.
    assert!(search("%").is_empty());
}

#[test]
fn retention_keeps_the_newest_events() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let script = touch(dir.path(), "a.py", "x");
    for i in 0..(MAX_EVENTS_PER_ITEM as u64 + 25) {
        workspace
            .record_at(
                &RecordEvent::new(ItemKind::Script, &script, EventKind::Open, Actor::Cli)
                    .with_detail(json!({"n": i})),
                at(i),
            )
            .unwrap();
    }
    let events = workspace.history(&script, 10_000).unwrap();
    assert_eq!(events.len(), MAX_EVENTS_PER_ITEM);
    assert_eq!(events[0].detail["n"], MAX_EVENTS_PER_ITEM as u64 + 24);
    assert_eq!(events.last().unwrap().detail["n"], 25);
    // The counter is not a function of the retained events.
    assert_eq!(
        workspace.find(&script).unwrap().unwrap().use_count,
        MAX_EVENTS_PER_ITEM as i64 + 25
    );
}

// ── legacy import ───────────────────────────────────────────────────────

fn legacy_fixture(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let present = touch(dir, "present.fms", "archive");
    let gone = dir.join("gone.fms");
    let index = json!({
        "format_version": 1,
        "generated_at": "2026-10-03T12:04:11Z",
        "scanned_locations": [{"path": dir.display().to_string(), "recursive": true}],
        "entries": [
            {
                "project_id": "7b1f0c2e-9a44-4d1b-8f52-2c9e0a7d1101",
                "name": "YIG waveguide",
                "path": present.display().to_string(),
                "solver": "FDM",
                "status": "running",
                "last_opened_at": "2026-10-03T12:04:02Z",
                "created_at": "2026-09-12T08:41:00Z",
                "size_bytes": 1420000000_u64,
                "revision": 42,
                "manifest_schema_version": "1.2",
                "pinned": true,
                "tags": ["magnonics", "YIG"],
                "thumbnail": "thumbs/7b1f0c2e.png",
                "authors": [{"name": "Mateusz Zelent", "role": "creator"}]
            },
            {
                "project_id": "c5d8f332-1b09-4c6a-91ef-3a7d50e95005",
                "name": "Vortex gyration",
                "path": gone.display().to_string(),
                "solver": "FEM",
                "status": "ready",
                "last_opened_at": "2026-09-18T09:14:00Z"
            },
            {"name": "relative path is skipped", "path": "relative/x.fms",
             "project_id": "x", "solver": "FDM", "status": "ready",
             "last_opened_at": "2026-09-18T09:14:00Z"}
        ]
    });
    let file = dir.join("recent-index.json");
    fs::write(&file, serde_json::to_string_pretty(&index).unwrap()).unwrap();
    (file, present, gone)
}

#[test]
fn legacy_index_imports_once_and_not_twice() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let (file, present, gone) = legacy_fixture(dir.path());

    let report = workspace.import_legacy_recent_index(&file).unwrap();
    assert_eq!(report.imported, 2);
    assert_eq!(report.skipped, 1);
    assert!(!report.already_imported);

    let item = workspace.find(&present).unwrap().unwrap();
    assert_eq!(item.kind, ItemKind::Project);
    assert_eq!(item.name, "YIG waveguide");
    assert!(item.pinned);
    assert_eq!(item.status, ItemStatus::Ready, "running is transient");
    assert_eq!(item.last_used_at, "2026-10-03T12:04:02.000Z");
    assert_eq!(item.first_seen_at, "2026-09-12T08:41:00.000Z");
    assert_eq!(item.use_count, 0);
    assert_eq!(item.meta["tags"], json!(["magnonics", "YIG"]));
    assert_eq!(item.meta["thumbnail_ref"], "thumbs/7b1f0c2e.png");
    assert_eq!(item.meta["solver"], "fdm");
    assert_eq!(item.meta["revision"], 42);
    assert_eq!(item.meta["schema_version"], "1.2");
    assert_eq!(item.meta["authors"][0]["name"], "Mateusz Zelent");
    assert_eq!(
        workspace.history(&present, 5).unwrap()[0].kind,
        EventKind::Import
    );

    let missing = workspace.find(&gone).unwrap().unwrap();
    assert_eq!(missing.status, ItemStatus::Missing, "file is gone");
    assert_eq!(missing.meta["solver"], "fem");

    let again = workspace.import_legacy_recent_index(&file).unwrap();
    assert!(again.already_imported);
    assert_eq!(again.imported, 0);
    assert_eq!(workspace.list(&Query::default()).unwrap().len(), 2);
    assert_eq!(workspace.history(&present, 50).unwrap().len(), 1);
    assert!(workspace.get_kv(LEGACY_IMPORT_MARKER).unwrap().is_some());
    // The legacy file is left in place and untouched.
    assert!(file.exists());
}

#[test]
fn legacy_import_keeps_what_the_database_already_knows() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let (file, present, _) = legacy_fixture(dir.path());
    workspace
        .record_at(
            &event(ItemKind::Project, &present, EventKind::Open)
                .with_project_id("7b1f0c2e-9a44-4d1b-8f52-2c9e0a7d1101")
                .with_meta_patch(json!({"revision": 50})),
            at(0),
        )
        .unwrap();
    workspace.import_legacy_recent_index(&file).unwrap();
    let item = workspace.find(&present).unwrap().unwrap();
    assert_eq!(item.use_count, 1, "counters are not overwritten");
    assert_eq!(item.meta["revision"], 50, "existing values win");
    assert_eq!(
        item.meta["tags"],
        json!(["magnonics", "YIG"]),
        "gaps are filled"
    );
    assert!(item.pinned, "a legacy pin is never lost");
    assert_eq!(workspace.list(&Query::default()).unwrap().len(), 2);
}

#[test]
fn legacy_import_edge_cases() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let nowhere = dir.path().join("nothing.json");
    let report = workspace.import_legacy_recent_index(&nowhere).unwrap();
    assert!(report.file_missing);
    assert!(workspace.get_kv(LEGACY_IMPORT_MARKER).unwrap().is_none());

    let bad = touch(dir.path(), "bad.json", "{not json");
    assert!(matches!(
        workspace.import_legacy_recent_index(&bad),
        Err(WorkspaceError::Invalid(_))
    ));
    let wrong = touch(
        dir.path(),
        "v2.json",
        r#"{"format_version": 2, "entries": []}"#,
    );
    assert!(matches!(
        workspace.import_legacy_recent_index(&wrong),
        Err(WorkspaceError::Invalid(_))
    ));
    assert!(workspace.get_kv(LEGACY_IMPORT_MARKER).unwrap().is_none());
}

#[test]
fn shipped_example_index_is_understood() {
    let example =
        include_str!("../../../docs/design/start-screen/schema/examples/recent-index.json");
    let entries = serde_json::from_str::<Value>(example).unwrap()["entries"]
        .as_array()
        .unwrap()
        .len();
    let dir = tempfile::tempdir().unwrap();
    let (workspace, _) = open(dir.path());
    let file = touch(dir.path(), "recent-index.json", example);
    let report = workspace.import_legacy_recent_index(&file).unwrap();
    // The example uses Windows drive paths: absolute (imported as missing)
    // on Windows, skipped as relative elsewhere. Either way nothing is lost
    // silently.
    assert_eq!(report.imported + report.skipped, entries);
    if cfg!(windows) {
        let items = workspace.list(&Query::default()).unwrap();
        assert_eq!(items.len(), entries);
        assert!(items.iter().all(|i| i.status == ItemStatus::Missing));
        assert!(items.iter().any(|i| i.pinned));
    }
}

// ── privacy ─────────────────────────────────────────────────────────────

#[test]
fn database_holds_no_file_contents_or_environment_values() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    let secret = "SECRET-BODY-d41d8cd98f00";
    let script = touch(
        dir.path(),
        "private.py",
        &format!("\"\"\"Summary line.\"\"\"\nimport fullmag\ntoken = '{secret}'\n"),
    );
    {
        let (workspace, _) = Workspace::open(&db).unwrap();
        let meta = script_meta(&script).unwrap();
        workspace
            .record(&event(ItemKind::Script, &script, EventKind::Run).with_meta_patch(meta))
            .unwrap();
        let item = workspace.find(&script).unwrap().unwrap();
        assert_eq!(item.meta["summary"], "Summary line.");
        assert_eq!(item.meta["lines"], 3);
        assert_eq!(item.meta["uses_fullmag"], true);
    }
    // Raw bytes of the database and any WAL sidecar.
    for entry in fs::read_dir(dir.path()).unwrap() {
        let path = entry.unwrap().path();
        if path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("workspace.db")
        {
            let bytes = fs::read(&path).unwrap();
            assert!(
                !bytes.windows(secret.len()).any(|w| w == secret.as_bytes()),
                "{} contains file contents",
                path.display()
            );
        }
    }
}

#[test]
fn redaction_hides_secret_looking_argument_values() {
    let args = [
        "--backend",
        "fdm",
        "--api-key",
        "abc123",
        "--password=hunter2",
        "--steps",
        "10",
        "--token",
        "--output-dir",
        "out",
    ];
    assert_eq!(
        redact_args(&args),
        [
            "--backend",
            "fdm",
            "--api-key",
            "***",
            "--password=***",
            "--steps",
            "10",
            "--token",
            "--output-dir",
            "out"
        ]
    );
}

// ── cross-language parity fixture ───────────────────────────────────────

/// Writes the fixture the Python parity test reads. Runs only when
/// `FULLMAG_WORKSPACE_PARITY_DB` names the file to create; otherwise a no-op.
/// Next to it, `<file>.expected.json` holds the order Rust returns for every
/// sort, so Python can assert it returns the same ordered lists.
#[test]
fn writes_parity_database_when_requested() {
    let Some(target) = std::env::var_os("FULLMAG_WORKSPACE_PARITY_DB") else {
        return;
    };
    let target = PathBuf::from(target);
    let _ = fs::remove_file(&target);
    let dir = target.parent().unwrap().to_path_buf();
    let files = dir.join("parity-files");
    fs::create_dir_all(&files).unwrap();
    let (workspace, _) = Workspace::open(&target).unwrap();
    seed(&workspace, &files);
    workspace
        .pin(&files.join("delta.py"), true, Actor::Desktop)
        .unwrap();
    workspace
        .record(
            &event(ItemKind::Project, &files.join("alpha.fms"), EventKind::Save)
                .with_meta_patch(json!({"authors": [{"name": "Ada Lovelace", "role": "creator"}]})),
        )
        .unwrap();

    let mut expected = serde_json::Map::new();
    for sort in [Sort::LastUsed, Sort::Name, Sort::UseCount] {
        let items = workspace
            .list(&Query {
                sort,
                ..Query::default()
            })
            .unwrap();
        expected.insert(
            sort.as_str().to_string(),
            json!(items.iter().map(|i| i.path.clone()).collect::<Vec<_>>()),
        );
    }
    let search = workspace
        .list(&Query {
            search: Some("lovelace".into()),
            ..Query::default()
        })
        .unwrap();
    expected.insert(
        "search_lovelace".into(),
        json!(search.iter().map(|i| i.path.clone()).collect::<Vec<_>>()),
    );
    let scripts = workspace
        .list(&Query {
            kind: Some(ItemKind::Script),
            ..Query::default()
        })
        .unwrap();
    expected.insert(
        "kind_script".into(),
        json!(scripts.iter().map(|i| i.path.clone()).collect::<Vec<_>>()),
    );
    let mut expected_path = target.as_os_str().to_os_string();
    expected_path.push(".expected.json");
    fs::write(
        expected_path,
        serde_json::to_string_pretty(&Value::Object(expected)).unwrap(),
    )
    .unwrap();
}
