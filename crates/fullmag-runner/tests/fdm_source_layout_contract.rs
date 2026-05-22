use std::path::{Path, PathBuf};

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn assert_exists(path: &Path) {
    assert!(
        path.exists(),
        "missing expected FDM runner owner path: {}",
        path.display()
    );
}

fn assert_absent(path: &Path) {
    assert!(
        !path.exists(),
        "legacy root-level FDM runner file must move under src/fdm: {}",
        path.display()
    );
}

#[test]
fn fdm_runner_cpu_and_native_cuda_sources_have_fdm_owner() {
    let root = crate_root();

    for path in [
        "src/fdm/mod.rs",
        "src/fdm/artifacts.rs",
        "src/fdm/cpu_reference.rs",
        "src/fdm/multilayer.rs",
        "src/fdm/multilayer_cuda.rs",
        "src/fdm/multilayer_reference.rs",
        "src/fdm/native_cuda.rs",
        "src/fdm/schedules.rs",
    ] {
        assert_exists(&root.join(path));
    }

    for path in [
        "src/cpu_reference.rs",
        "src/multilayer_cuda.rs",
        "src/multilayer_reference.rs",
        "src/native_fdm.rs",
    ] {
        assert_absent(&root.join(path));
    }
}

#[test]
fn fdm_runner_due_field_recording_has_schedule_owner() {
    let root = crate_root();
    assert_exists(&root.join("src/fdm/schedules.rs"));

    for path in [
        "src/fdm/multilayer_cuda.rs",
        "src/fdm/multilayer_reference.rs",
    ] {
        let source = std::fs::read_to_string(root.join(path)).expect("read FDM runner source");
        assert!(
            !source.contains("fn record_due_fields("),
            "FDM due-field recording must be owned by src/fdm/schedules.rs, not {path}"
        );
    }
}

#[test]
fn fdm_runner_multilayer_step_stats_have_multilayer_owner() {
    let root = crate_root();
    assert_exists(&root.join("src/fdm/multilayer.rs"));

    for path in [
        "src/fdm/multilayer_cuda.rs",
        "src/fdm/multilayer_reference.rs",
    ] {
        let source = std::fs::read_to_string(root.join(path)).expect("read FDM multilayer source");
        assert!(
            !source.contains("fn make_step_stats("),
            "FDM multilayer StepStats construction must be owned by src/fdm/multilayer.rs, not {path}"
        );
    }
}

#[test]
fn fdm_runner_field_snapshot_selection_has_artifact_owner() {
    let root = crate_root();
    assert_exists(&root.join("src/fdm/artifacts.rs"));

    for path in [
        "src/fdm/cpu_reference.rs",
        "src/fdm/multilayer_cuda.rs",
        "src/fdm/multilayer_reference.rs",
    ] {
        let source = std::fs::read_to_string(root.join(path)).expect("read FDM runner source");
        assert!(
            !source.contains("fn select_field_values("),
            "FDM field snapshot selection must be owned by src/fdm/artifacts.rs, not {path}"
        );
    }
}
