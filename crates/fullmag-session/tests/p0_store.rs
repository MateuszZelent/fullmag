//! Synthetic repositories only: no user store is opened by these regressions.
use fullmag_session::{
    CommonSolverState, FmsCheckpoint, FmsSessionManifest, SaveProfile, SessionStore, SolverEnergies,
};

#[test]
fn session_recovery_preserves_other_sessions_and_rejects_mismatched_identity() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    for id in ["session-a", "session-b"] {
        store.write_recovery(&FmsSessionManifest::new(id, id, SaveProfile::Compact)).unwrap();
    }
    assert_eq!(store.read_session_recovery("session-a").unwrap().unwrap().session_id, "session-a");
    assert_eq!(store.clear_session_recovery("session-a").unwrap(), 1);
    assert_eq!(store.clear_session_recovery("session-a").unwrap(), 0);
    assert!(store.read_session_recovery("session-b").unwrap().is_some());
    let foreign = std::fs::read(store.root().join("recovery/session-b.json")).unwrap();
    std::fs::write(store.root().join("recovery/session-a.json"), &foreign).unwrap();
    assert!(store.read_session_recovery("session-a").is_err());
    assert!(store.clear_session_recovery("session-a").is_err());
    assert_eq!(std::fs::read(store.root().join("recovery/session-a.json")).unwrap(), foreign);
    assert!(store.clear_session_recovery("../escape").is_err());
}

#[test]
fn malicious_ids_and_control_documents_never_escape_or_replace_the_lock() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    for id in [
        "../escape",
        "/absolute",
        "C:drive",
        "a\\b",
        "NUL",
        "CON.json",
        "CONIN$",
        "CONOUT$",
        "COM¹",
        "LPT¹",
        "trailing.",
    ] {
        let manifest = FmsSessionManifest::new(id, "invalid", SaveProfile::Compact);
        assert!(store.commit_session(&manifest).is_err(), "{id}");
        assert!(store.write_recovery(&manifest).is_err(), "{id}");
        assert!(store.read_run(id).is_err(), "{id}");
    }
    for path in [
        "../escape",
        "WRITER.lock",
        "LOCK",
        "CURRENT",
        "runs/run-1/run_manifest.json",
        "recovery/broken.json",
        "manifest/session.json",
        "objects/sha256/fake",
        "project/../../escape",
    ] {
        assert!(store.write_document(path, b"tampered").is_err(), "{path}");
    }
    assert!(!directory.path().join("escape").exists());
    assert!(store.current_session().unwrap().is_none());
}

#[test]
fn second_writer_and_foreign_unlock_do_not_mutate_the_store() {
    let directory = tempfile::tempdir().unwrap();
    let first = SessionStore::open(directory.path().join("store")).unwrap();
    let second = SessionStore::open(first.root()).unwrap();
    assert!(first.try_lock("owner-one").unwrap());
    assert!(!second.try_lock("owner-two").unwrap());
    assert!(second.unlock().is_err());
    assert!(second
        .write_document("project/main.py", b"foreign")
        .is_err());
    first.write_document("project/main.py", b"owner").unwrap();
    assert_eq!(
        first.read_document("project/main.py").unwrap().unwrap(),
        b"owner"
    );
    first.unlock().unwrap();
    second
        .write_document("project/main.py", b"next-owner")
        .unwrap();
}

#[test]
fn same_step_captures_have_distinct_immutable_ids() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let first = FmsCheckpoint::new("run-1", 7, 1e-9, 1e-12);
    let second = FmsCheckpoint::new("run-1", 7, 1e-9, 1e-12);
    assert_ne!(first.checkpoint_id, second.checkpoint_id);
    let state = CommonSolverState {
        step: 7,
        time_s: 1e-9,
        dt: 1e-12,
        energies: SolverEnergies::default(),
        magnetization_ref: None,
    };
    store.commit_checkpoint(&first, &state).unwrap();
    assert!(store.commit_checkpoint(&first, &state).is_err());
    store.commit_checkpoint(&second, &state).unwrap();
    assert_eq!(store.list_checkpoints("run-1").unwrap().len(), 2);
}

#[test]
fn cas_opened_before_session_uses_the_same_writer() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("store");
    let cas = fullmag_session::CasStore::open(root.join("objects")).unwrap();
    let store = SessionStore::open(&root).unwrap();
    let lease = store.write_transaction().unwrap();
    assert!(cas.put(b"must wait for session writer").is_err());
    drop(lease);
    assert!(cas.put(b"next writer").is_ok());
    assert!(!root.join("objects/WRITER.lock").exists());
}

#[test]
fn missing_checkpoint_object_never_publishes_its_marker() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let checkpoint = FmsCheckpoint::new("run-1", 1, 0.0, 1e-12);
    let state = CommonSolverState {
        step: 1,
        time_s: 0.0,
        dt: 1e-12,
        energies: SolverEnergies::default(),
        magnetization_ref: Some("0".repeat(64)),
    };
    assert!(store.commit_checkpoint(&checkpoint, &state).is_err());
    assert!(store.latest_checkpoint("run-1").unwrap().is_none());
}

#[test]
fn incomplete_checkpoint_is_not_published_and_corrupt_committed_state_is_an_error() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let checkpoint = FmsCheckpoint::new("run-1", 1, 0.0, 1e-12);
    let common = store.root().join(&checkpoint.common_state_ref);
    std::fs::create_dir_all(common.parent().unwrap()).unwrap();
    std::fs::write(common, b"{}").unwrap();
    assert!(store.latest_checkpoint("run-1").unwrap().is_none());
    let path = format!(
        "runs/run-1/checkpoints/{}/checkpoint.json",
        checkpoint.checkpoint_id
    );
    std::fs::write(
        store.root().join(&path),
        serde_json::to_vec(&checkpoint).unwrap(),
    )
    .unwrap();
    assert!(store.latest_checkpoint("run-1").is_err());
    assert!(store.gc_preview().is_err());
}

#[test]
fn truncated_magnetization_does_not_silently_discard_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let hash = store.store_blob(&[0; 25]).unwrap();
    assert!(store.load_magnetization(&hash).is_err());
}

#[test]
fn current_pointer_keeps_previous_manifest_generations() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let mut manifest = FmsSessionManifest::new("session-1", "first", SaveProfile::Compact);
    store.commit_session(&manifest).unwrap();
    let first = std::fs::read(store.root().join("CURRENT")).unwrap();
    manifest.name = "second".into();
    store.commit_session(&manifest).unwrap();
    let second = std::fs::read(store.root().join("CURRENT")).unwrap();
    assert_ne!(first, second);
    let previous = store
        .root()
        .join("manifests")
        .join(format!("{}.json", String::from_utf8(first).unwrap()));
    let saved: FmsSessionManifest =
        serde_json::from_slice(&std::fs::read(previous).unwrap()).unwrap();
    assert_eq!(saved.name, "first");
    assert_eq!(store.current_session().unwrap().unwrap().name, "second");
}

#[test]
fn gc_preview_never_deletes_and_apply_rejects_a_stale_plan() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    // Seed a genuinely unowned object in this synthetic repository. Normal
    // ingest is pinned until publication and must never be treated as garbage.
    let garbage = b"synthetic unowned bytes";
    let hash = fullmag_session::hex_sha256(garbage);
    let path = store.root().join("objects/sha256").join(&hash);
    std::fs::write(&path, garbage).unwrap();
    let plan = store.gc_preview().unwrap();
    assert_eq!(plan.candidates, vec![hash.clone()]);
    assert!(path.exists());
    let pinned = store.store_blob(b"not yet committed checkpoint").unwrap();
    assert!(store.gc_apply(store.root(), &plan).is_err());
    assert!(path.exists());
    let fresh = store.gc_preview().unwrap();
    assert_eq!(fresh.candidates, vec![hash]);
    assert_eq!(store.gc_apply(store.root(), &fresh).unwrap(), 1);
    assert!(!path.exists());
    assert!(store.cas().contains(&pinned));
}

#[test]
fn gc_corrupt_recovery_prevents_any_sweep() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let bytes = b"synthetic orphan";
    let hash = fullmag_session::hex_sha256(bytes);
    let path = store.root().join("objects/sha256").join(hash);
    std::fs::write(&path, bytes).unwrap();
    let plan = store.gc_preview().unwrap();
    std::fs::write(store.root().join("recovery/broken.json"), b"{").unwrap();
    assert!(store.gc_preview().is_err());
    assert!(store.gc_apply(store.root(), &plan).is_err());
    assert!(path.exists());
}

#[test]
fn process_lock_child() {
    let Ok(root) = std::env::var("FULLMAG_P0_TEST_CHILD_ROOT") else {
        return;
    };
    let store = SessionStore::open_existing(root).unwrap();
    let _lease = store.write_transaction().unwrap();
    store
        .write_document("project/child-ready", b"ready")
        .unwrap();
    std::thread::sleep(std::time::Duration::from_secs(30));
}

#[test]
fn process_death_releases_native_lease_without_pid_based_stealing() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "process_lock_child", "--nocapture"])
        .env("FULLMAG_P0_TEST_CHILD_ROOT", store.root())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let ready = store.root().join("project/child-ready");
    while !ready.exists() && std::time::Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let did_start = ready.exists();
    let blocked = store
        .write_document("project/from-parent", b"must wait")
        .is_err();
    let _ = child.kill();
    child.wait().unwrap();
    assert!(did_start, "child did not acquire the lease before deadline");
    assert!(blocked, "parent wrote while child owned the native lease");
    store
        .write_document("project/from-parent", b"after child exit")
        .unwrap();
}
