from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


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
