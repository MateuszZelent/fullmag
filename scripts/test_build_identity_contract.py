import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_build_script_prefers_exact_injected_managed_source_identity(
    tmp_path: Path,
) -> None:
    crate_dir = tmp_path / "workspace" / "crates" / "fullmag-build-info"
    crate_dir.mkdir(parents=True)
    build_rs = crate_dir / "build.rs"
    build_rs.write_bytes((ROOT / "crates/fullmag-build-info/build.rs").read_bytes())
    builder = tmp_path / "fullmag-build-info-builder"
    compile_result = subprocess.run(
        ["rustc", str(build_rs), "-o", str(builder)],
        env={**os.environ, "CARGO_MANIFEST_DIR": str(crate_dir)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    result = subprocess.run(
        [str(builder)],
        env={
            **os.environ,
            "FULLMAG_SOURCE_GIT_COMMIT": "0123abcd" * 5,
            "FULLMAG_SOURCE_WORKTREE_STATE": "dirty",
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": "45" * 32,
            "SOURCE_DATE_EPOCH": "0",
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "cargo:rerun-if-env-changed=FULLMAG_SOURCE_GIT_COMMIT" in result.stdout
    assert "cargo:rerun-if-env-changed=FULLMAG_SOURCE_WORKTREE_STATE" in result.stdout
    assert "cargo:rerun-if-env-changed=FULLMAG_SOURCE_SNAPSHOT_SHA256" in result.stdout
    assert f"cargo:rustc-env=FULLMAG_BUILD_GIT_COMMIT={'0123abcd' * 5}" in result.stdout
    assert "cargo:rustc-env=FULLMAG_BUILD_WORKTREE_STATE=dirty" in result.stdout
    assert f"cargo:rustc-env=FULLMAG_BUILD_SOURCE_SNAPSHOT_SHA256={'45' * 32}" in result.stdout


def test_cli_and_api_print_shared_build_identity_before_argument_handling() -> None:
    cli = (ROOT / "crates/fullmag-cli/src/main.rs").read_text(encoding="utf-8")
    api = (ROOT / "crates/fullmag-api/src/main.rs").read_text(encoding="utf-8")

    assert "fullmag_build_info::print_startup_stamp();" in cli.split(
        "fn main()", 1
    )[1][:180]
    assert "fullmag_build_info::print_startup_stamp();" in api.split(
        "async fn main()", 1
    )[1][:180]


def test_shared_build_identity_captures_time_commit_and_worktree_state() -> None:
    build_rs = (ROOT / "crates/fullmag-build-info/build.rs").read_text(
        encoding="utf-8"
    )

    assert "SOURCE_DATE_EPOCH" in build_rs
    assert "rev-parse" in build_rs
    assert "status" in build_rs
    assert "FULLMAG_BUILD_TIMESTAMP_UTC" in build_rs
    assert "FULLMAG_BUILD_GIT_COMMIT" in build_rs
    assert "FULLMAG_BUILD_WORKTREE_STATE" in build_rs


def test_build_identity_is_one_workspace_dependency() -> None:
    workspace = (ROOT / "Cargo.toml").read_text(encoding="utf-8")
    cli_manifest = (ROOT / "crates/fullmag-cli/Cargo.toml").read_text(encoding="utf-8")
    api_manifest = (ROOT / "crates/fullmag-api/Cargo.toml").read_text(encoding="utf-8")

    assert '"crates/fullmag-build-info"' in workspace
    assert 'fullmag-build-info = { path = "crates/fullmag-build-info" }' in workspace
    assert "fullmag-build-info.workspace = true" in cli_manifest
    assert "fullmag-build-info.workspace = true" in api_manifest


def test_authoritative_build_routes_refresh_the_embedded_identity() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    exporter = (ROOT / "scripts/export_fem_gpu_runtime.sh").read_text(encoding="utf-8")

    assert 'cargo +nightly clean -p fullmag-build-info' in makefile
    assert "cargo +nightly clean -p fullmag-build-info" in exporter
    assert "cargo +nightly clean --workspace --release" not in exporter
