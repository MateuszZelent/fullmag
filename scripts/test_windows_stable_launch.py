"""Filesystem fixtures only; no real executable, native launcher, or firewall changes."""
import json
import os
from pathlib import Path

import pytest
import test_windows_runtime_bundle as bundle_fixtures
from windows import stable_launch as launch


@pytest.fixture
def fixture(monkeypatch):
    source = bundle_fixtures.WindowsRuntimeBundleTests()
    source.setUp()
    layout = {"repo_root": str(source.root), "runtime_root": str(source.runtime_root),
              "worktree_id": "fixture-worktree", "profile": "windows-native-fdm-cpu-dev"}
    nonce = "e" * 32
    status = {"schema": "fullmag_storage_v1", "state": "starting", **layout,
              "launch_nonce": nonce, "launcher_pid": os.getppid(), "manager_pid": os.getpid()}
    path = source.runtime_root / launch.STATUS_NAME
    path.write_text(json.dumps(status))
    monkeypatch.setenv("FULLMAG_NATIVE_RUNTIME_ACTIVE", "1")
    monkeypatch.setenv("FULLMAG_NATIVE_RUNTIME_NONCE", nonce)
    monkeypatch.setattr(launch.storage, "resolve_layout", lambda *args, **kwargs: layout)
    bundle = source.build_bundle()["bundle_root"]
    try:
        yield source, layout, nonce, path, status, bundle
    finally:
        source.tearDown()


def test_relaunch_keeps_executable_path_and_verifies_new_generation(fixture, monkeypatch):
    source, layout, nonce, path, status, bundle = fixture
    first = launch.publish_launch_copy(layout["repo_root"], bundle, "dev")
    assert launch.validate_launch_copy(layout["repo_root"], bundle, "dev", nonce) == first
    source.data["fullmag-api.exe"] = b"updated fixture executable"
    import hashlib
    updated = hashlib.sha256(source.data["fullmag-api.exe"]).hexdigest()
    (source.profile_dir / "fullmag-api.exe").write_bytes(source.data["fullmag-api.exe"])
    source.source_manifest["api_binary_sha256"] = updated
    source.source_manifest["executable_sha256"]["fullmag-api.exe"] = updated
    source.write_source_manifest()
    second_bundle = source.build_bundle()["bundle_root"]
    nonce = "f" * 32
    path.write_text(json.dumps({**status, "launch_nonce": nonce}))
    monkeypatch.setenv("FULLMAG_NATIVE_RUNTIME_NONCE", nonce)
    second = launch.publish_launch_copy(layout["repo_root"], second_bundle, "dev")
    assert second["fullmag_exe"] == first["fullmag_exe"]
    assert Path(first["fullmag_exe"]).parent.joinpath("fullmag-api.exe").read_bytes() == source.data["fullmag-api.exe"]
    assert Path(bundle, "bin/fullmag-api.exe").read_bytes() != source.data["fullmag-api.exe"]
    launch.validate_launch_copy(layout["repo_root"], second_bundle, "dev", nonce)
    with pytest.raises(launch.StableLaunchError):
        launch.validate_launch_copy(layout["repo_root"], bundle, "dev", nonce)


@pytest.mark.parametrize("changed", [{"state": "running"}, {"launch_nonce": "f" * 32},
                                    {"launcher_pid": 1}, {"worktree_id": "foreign"}])
def test_unowned_publication_rejected_before_creating_execution_view(fixture, changed):
    source, layout, nonce, path, status, bundle = fixture
    path.write_text(json.dumps({**status, **changed}))
    with pytest.raises(launch.StableLaunchError):
        launch.publish_launch_copy(layout["repo_root"], bundle, "dev")
    assert not (source.runtime_root / "native-launch").exists()


def test_partial_publication_is_rejected_and_next_start_can_repair_it(fixture, monkeypatch):
    source, layout, nonce, path, status, bundle = fixture
    replace = launch.os.replace
    def fail_api(source_path, destination):
        if Path(destination).name == "fullmag-api.exe":
            raise PermissionError("fixture target in use")
        return replace(source_path, destination)
    monkeypatch.setattr(launch.os, "replace", fail_api)
    with pytest.raises(launch.StableLaunchError, match="no retry"):
        launch.publish_launch_copy(layout["repo_root"], bundle, "dev")
    with pytest.raises(launch.StableLaunchError):
        launch.validate_launch_copy(layout["repo_root"], bundle, "dev", nonce)
    assert list((source.runtime_root / "native-launch/dev").glob(".staging-*"))
    monkeypatch.setattr(launch.os, "replace", replace)
    result = launch.publish_launch_copy(layout["repo_root"], bundle, "dev")
    assert launch.validate_launch_copy(layout["repo_root"], bundle, "dev", nonce) == result


def test_corrupted_copy_cannot_publish_ready_proof(fixture):
    source, layout, nonce, path, status, bundle = fixture
    result = launch.publish_launch_copy(layout["repo_root"], bundle, "dev")
    Path(result["fullmag_exe"]).write_bytes(b"corrupt")
    with pytest.raises(launch.StableLaunchError):
        launch.validate_launch_copy(layout["repo_root"], bundle, "dev", nonce)


def test_foreign_bundle_namespace_rejected_before_publication(fixture):
    source, layout, nonce, path, status, bundle = fixture
    source.source_manifest["workspace_namespace"] = "foreign"
    source.write_source_manifest()
    foreign = source.build_bundle()["bundle_root"]
    with pytest.raises(launch.StableLaunchError, match="different workspace"):
        launch.publish_launch_copy(layout["repo_root"], foreign, "dev")
    assert not (source.runtime_root / "native-launch").exists()
