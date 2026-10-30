//! Synthetic preparation receipt directory regressions.
//!
//! These tests use temporary stores only.  They cover the lock-free reader's
//! distinction between the exact atomic-write staging name and durable data.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use fullmag_session::{
    FmsPreparationProcessExitReceipt, FmsPreparationProcessLaunch, SessionStore,
    FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA, FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA,
};

const RUN_ID: &str = "run-preparation-receipt-scan";
const TASK_ID: &str = "task-preparation-receipt-scan";
const ATTEMPT_ID: &str = "prep-attempt-receipt-scan";
const RESOURCE_ID: &str = "cpu-preparation-receipt-scan";
const LEASE_TOKEN: &str = "prep-lease-receipt-scan";

fn store() -> (tempfile::TempDir, SessionStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    (directory, store)
}

fn exit_root(store: &SessionStore) -> PathBuf {
    store
        .root()
        .join("runs")
        .join(RUN_ID)
        .join("preparation_process_exit_receipts")
}

fn launch_root(store: &SessionStore) -> PathBuf {
    store
        .root()
        .join("runs")
        .join(RUN_ID)
        .join("preparation_process_launches")
}

fn staging_name(sequence: u8) -> String {
    format!(".550e8400-e29b-41d4-a716-4466554400{sequence:02}.part")
}

fn exit_receipt(receipt_id: &str) -> FmsPreparationProcessExitReceipt {
    FmsPreparationProcessExitReceipt {
        schema_version: FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
        receipt_id: receipt_id.into(),
        run_id: RUN_ID.into(),
        task_id: TASK_ID.into(),
        preparation_attempt_id: ATTEMPT_ID.into(),
        resource_id: RESOURCE_ID.into(),
        lease_token: LEASE_TOKEN.into(),
        lease_heartbeat_sequence: 0,
        process_id: 101,
        process_start_token: Some("preparation-receipt-process".into()),
        status_success: true,
        exit_code: Some(0),
        timed_out: false,
        failure_reason: None,
        observed_at: Utc::now(),
    }
}

fn process_launch(launch_id: &str) -> FmsPreparationProcessLaunch {
    FmsPreparationProcessLaunch {
        schema_version: FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
        launch_id: launch_id.into(),
        run_id: RUN_ID.into(),
        task_id: TASK_ID.into(),
        preparation_attempt_id: ATTEMPT_ID.into(),
        resource_id: RESOURCE_ID.into(),
        lease_token: LEASE_TOKEN.into(),
        lease_heartbeat_sequence: 0,
        supervisor_process_id: 102,
        supervisor_start_token: Some("preparation-receipt-supervisor".into()),
        created_at: Utc::now(),
    }
}

fn write_json(path: &Path, value: &impl serde::Serialize) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

#[test]
fn exit_listing_ignores_two_canonical_staging_files_and_sees_renamed_receipt() {
    let (_directory, store) = store();
    assert!(store
        .list_preparation_process_exit_receipts(RUN_ID)
        .unwrap()
        .is_empty());

    let root = exit_root(&store);
    fs::create_dir_all(&root).unwrap();
    let first_stage = root.join(staging_name(0));
    let second_stage = root.join(staging_name(1));
    fs::write(&first_stage, b"partial first receipt").unwrap();
    fs::write(&second_stage, b"partial second receipt").unwrap();
    assert!(store
        .list_preparation_process_exit_receipts(RUN_ID)
        .unwrap()
        .is_empty());

    let receipt = exit_receipt("prep-exit-visible");
    let staged_receipt = root.join(staging_name(2));
    write_json(&staged_receipt, &receipt);
    assert!(store
        .list_preparation_process_exit_receipts(RUN_ID)
        .unwrap()
        .is_empty());
    fs::rename(&staged_receipt, root.join("prep-exit-visible.json")).unwrap();

    let listed = store
        .list_preparation_process_exit_receipts(RUN_ID)
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].receipt_id, "prep-exit-visible");
}

#[test]
fn launch_listing_keeps_empty_pending_and_ignores_canonical_staging_file() {
    let (_directory, store) = store();
    assert!(store
        .list_preparation_process_launches(RUN_ID)
        .unwrap()
        .is_empty());

    let root = launch_root(&store);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(staging_name(0)), b"partial launch").unwrap();
    let launch = process_launch("prep-launch-visible");
    write_json(&root.join("prep-launch-visible.json"), &launch);

    let listed = store.list_preparation_process_launches(RUN_ID).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].launch_id, "prep-launch-visible");
}

#[test]
fn durable_null_and_malformed_receipts_remain_hard_failures() {
    for payload in [b"null".as_slice(), b"{".as_slice()] {
        let (_directory, store) = store();
        let exit_path = exit_root(&store).join("prep-exit-invalid.json");
        fs::create_dir_all(exit_path.parent().unwrap()).unwrap();
        fs::write(&exit_path, payload).unwrap();
        let error = store
            .list_preparation_process_exit_receipts(RUN_ID)
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("parsing preparation process exit receipt"));

        let launch_path = launch_root(&store).join("prep-launch-invalid.json");
        fs::create_dir_all(launch_path.parent().unwrap()).unwrap();
        fs::write(&launch_path, payload).unwrap();
        let error = store.list_preparation_process_launches(RUN_ID).unwrap_err();
        assert!(error
            .to_string()
            .contains("parsing preparation process launch"));
    }
}

fn assert_exit_listing_rejects_entry(entry_name: &str, directory: bool) {
    let (_directory, store) = store();
    let path = exit_root(&store).join(entry_name);
    if directory {
        fs::create_dir_all(&path).unwrap();
    } else {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"unrecognized staging").unwrap();
    }
    assert!(store
        .list_preparation_process_exit_receipts(RUN_ID)
        .is_err());
}

fn assert_launch_listing_rejects_entry(entry_name: &str, directory: bool) {
    let (_directory, store) = store();
    let path = launch_root(&store).join(entry_name);
    if directory {
        fs::create_dir_all(&path).unwrap();
    } else {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"unrecognized staging").unwrap();
    }
    assert!(store.list_preparation_process_launches(RUN_ID).is_err());
}

#[test]
fn unrecognized_staging_names_and_directories_remain_hard_failures() {
    for entry_name in [
        "garbage.part",
        "not-json",
        "prep-exit-invalid.json.tmp",
        ".not-a-uuid.part",
        ".550e8400-e29b-41d4-a716-446655440000.part.bak",
    ] {
        assert_exit_listing_rejects_entry(entry_name, false);
        assert_launch_listing_rejects_entry(entry_name, false);
    }
    let canonical = staging_name(0);
    assert_exit_listing_rejects_entry(&canonical, true);
    assert_launch_listing_rejects_entry(&canonical, true);
}

#[cfg(unix)]
#[test]
fn staging_symlink_remains_a_hard_failure() {
    use std::os::unix::fs::symlink;

    let (_directory, store) = store();
    let target = store.root().join("symlink-target");
    fs::write(&target, b"not a durable receipt").unwrap();
    let path = exit_root(&store).join(staging_name(0));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    symlink(&target, &path).unwrap();
    assert!(store
        .list_preparation_process_exit_receipts(RUN_ID)
        .is_err());

    let launch_path = launch_root(&store).join(staging_name(1));
    fs::create_dir_all(launch_path.parent().unwrap()).unwrap();
    symlink(&target, &launch_path).unwrap();
    assert!(store.list_preparation_process_launches(RUN_ID).is_err());
}
