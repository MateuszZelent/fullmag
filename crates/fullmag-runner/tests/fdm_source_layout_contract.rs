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

fn assert_source_does_not_contain(path: &Path, needle: &str) {
    let source = std::fs::read_to_string(path).unwrap_or_else(|err| {
        panic!(
            "read FDM source layout contract input {}: {err}",
            path.display()
        )
    });
    assert!(
        !source.contains(needle),
        "legacy FDM compatibility module must be removed from {}: {needle}",
        path.display()
    );
}

#[test]
fn fdm_runner_cpu_and_native_cuda_sources_have_fdm_owner() {
    let root = crate_root();

    for path in [
        "src/fdm/mod.rs",
        "src/fdm/artifacts.rs",
        "src/fdm/cpu/mod.rs",
        "src/fdm/cpu/reference.rs",
        "src/fdm/cpu/multilayer_reference.rs",
        "src/fdm/gpu/mod.rs",
        "src/fdm/gpu/cuda/mod.rs",
        "src/fdm/gpu/cuda/multilayer.rs",
        "src/fdm/gpu/cuda/native.rs",
        "src/fdm/multilayer.rs",
        "src/fdm/schedules.rs",
    ] {
        assert_exists(&root.join(path));
    }

    for path in [
        "src/cpu_reference.rs",
        "src/multilayer_cuda.rs",
        "src/multilayer_reference.rs",
        "src/native_fdm.rs",
        "src/fdm/cpu_reference.rs",
        "src/fdm/multilayer_cuda.rs",
        "src/fdm/multilayer_reference.rs",
        "src/fdm/native_cuda.rs",
    ] {
        assert_absent(&root.join(path));
    }
}

#[test]
fn fdm_runner_callers_use_owner_modules_not_root_compatibility_shims() {
    let root = crate_root();

    for needle in [
        "mod cpu_reference {",
        "mod multilayer_reference {",
        "mod native_fdm {",
        "mod multilayer_cuda {",
    ] {
        assert_source_does_not_contain(&root.join("src/lib.rs"), needle);
    }

    for needle in [
        "pub(crate) mod cpu_reference {",
        "pub(crate) mod multilayer_reference {",
        "pub(crate) mod native_cuda {",
        "pub(crate) mod multilayer_cuda {",
    ] {
        assert_source_does_not_contain(&root.join("src/fdm/mod.rs"), needle);
    }
}

#[test]
fn fdm_runner_due_field_recording_has_schedule_owner() {
    let root = crate_root();
    assert_exists(&root.join("src/fdm/schedules.rs"));

    for path in [
        "src/fdm/gpu/cuda/multilayer.rs",
        "src/fdm/cpu/multilayer_reference.rs",
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
        "src/fdm/gpu/cuda/multilayer.rs",
        "src/fdm/cpu/multilayer_reference.rs",
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
        "src/fdm/cpu/reference.rs",
        "src/fdm/gpu/cuda/multilayer.rs",
        "src/fdm/cpu/multilayer_reference.rs",
    ] {
        let source = std::fs::read_to_string(root.join(path)).expect("read FDM runner source");
        assert!(
            !source.contains("fn select_field_values("),
            "FDM field snapshot selection must be owned by src/fdm/artifacts.rs, not {path}"
        );
    }
}

#[test]
fn native_m1_v1_build_inputs_and_abi_translation_unit_are_fail_closed() {
    let root = crate_root();
    let build_rs = std::fs::read_to_string(root.join("../fullmag-fdm-sys/build.rs"))
        .expect("read fullmag-fdm-sys build script");
    assert!(
        build_rs.contains("cargo:rerun-if-changed=../../backends/fdm/cpu"),
        "native M1 owner sources must invalidate Cargo native builds"
    );

    let cmake = std::fs::read_to_string(root.join("../../backends/fdm/CMakeLists.txt"))
        .expect("read FDM CMake contract");
    assert!(
        cmake.contains("add_library(fullmag_fdm_cpu_transport_abi OBJECT"),
        "the public transport ABI must have a dedicated translation-unit target"
    );
    let target_start = cmake
        .find("target_compile_options(fullmag_fdm_cpu_transport_abi PRIVATE")
        .expect("ABI target must own strict compile options");
    let target_contract = &cmake[target_start..];
    for flag in ["-Wall", "-Wextra", "-Wpedantic", "-Werror"] {
        assert!(
            target_contract.contains(flag),
            "ABI translation unit must compile with {flag}"
        );
    }
}
