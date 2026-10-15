"""Focused checks for reusing a pinned native FEM development frontend stage.

These fixtures exercise only sealed manifest admission and the command handoff.
They do not invoke PowerShell, pnpm, Cargo, a solver, or a browser.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import socket
import sys

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent))
import fullmag_storage as storage
from windows import build_snapshot


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class _ReuseFixture:
    inventory_sha256 = "a" * 64
    snapshot_inventory_sha256 = "b" * 64

    def __init__(self, root: Path):
        self.root = root.resolve()
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                self.port = int(probe.getsockname()[1])
        except OSError as error:
            pytest.skip(f"fixture requires a local socket for port admission: {error}")
        self.storage_root = self.root / "storage"
        self.build_storage_root = self.storage_root / "builds"
        self.build_root = self.build_storage_root / "fixture" / "windows-native-fem-gpu"
        self.build_root.mkdir(parents=True)

        self.snapshot_root = self.build_root / "source-snapshots" / "snapshot" / "source"
        self.snapshot_root.mkdir(parents=True)
        (self.snapshot_root / "README.md").write_text("frozen frontend input\n", encoding="utf-8")
        self.snapshot_record = self.snapshot_root.parent / "record.json"
        self.snapshot_record.write_text("{}\n", encoding="utf-8")
        self.frozen_snapshot = {
            "record_path": str(self.snapshot_record),
            "inventory_sha256": self.snapshot_inventory_sha256,
            "source_root": str(self.snapshot_root),
        }

        self.stage_root = self.build_root / "frontend-sources" / "stage"
        self.workspace_root = self.stage_root / "workspace"
        self.workspace_root.joinpath("apps", "control-room").mkdir(parents=True)
        self.cache_root = self.build_root / "frontend" / "workspace" / "stage"
        (self.cache_root / "next" / f"dev-{self.port}").mkdir(parents=True)
        self.app_root = self.workspace_root / "apps" / "control-room"
        self.dev_link = self.app_root / f".next-control-room-{self.port}"
        try:
            self.dev_link.symlink_to(
                self.cache_root / "next" / f"dev-{self.port}", target_is_directory=True
            )
        except OSError as error:
            pytest.skip(f"fixture requires directory links: {error}")

        self.stage_manifest_path = self.stage_root / "frontend-source-manifest.json"
        self.build_manifest_path = self.build_root / "windows-fem-runtime" / "build-manifest.json"
        self.build_manifest_path.parent.mkdir(parents=True)
        self.repo_root = self.root / "repo"
        self.repo_root.joinpath("scripts", "windows").mkdir(parents=True)
        (self.repo_root / "scripts" / "windows" / "run_fullmag.ps1").write_text(
            "# fixture launcher\n", encoding="utf-8"
        )
        self.script_path = self.repo_root / "example.py"
        self.script_path.write_text("print('fixture')\n", encoding="utf-8")

        self.layout = {
            "build_root": str(self.build_root),
            "build_storage_root": str(self.storage_root),
            "storage_root": str(self.storage_root),
            "runtime_root": str(self.storage_root / "runtime"),
            "runs_root": str(self.storage_root / "runs"),
            "repo_root": str(self.repo_root),
            "worktree_id": "fixture",
            "profile": "windows-native-fem-gpu",
            "project_root": str(self.root),
            "env": {},
        }
        self._write_stage()

    def _write_stage(self, **changes: object) -> None:
        stage = {
            "schema": "fullmag.native-workspace-frontend-source.v1",
            "mode": "dev",
            "build_root": str(self.build_root),
            "source_root": str(self.snapshot_root),
            "workspace_root": str(self.workspace_root),
            "frontend_cache_root": str(self.cache_root),
            "source_inventory_sha256": self.inventory_sha256,
            "build_source_snapshot": self.frozen_snapshot,
            "web_port": self.port,
        }
        stage.update(changes)
        self.stage_manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.stage_manifest_path.write_text(
            json.dumps(stage, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        manifest = {
            "schema_version": 1,
            "state": "completed",
            "backend": "fem",
            "frontend_mode": "dev",
            "build_source_snapshot": self.frozen_snapshot,
            "frontend_source_manifest": str(self.stage_manifest_path),
            "frontend_source_manifest_sha256": _sha256(self.stage_manifest_path),
            "frontend_source_sha256": self.inventory_sha256,
            "frontend_workspace_root": str(self.workspace_root),
            "frontend_cache_root": str(self.cache_root),
        }
        self.build_manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

    @property
    def build_manifest_sha256(self) -> str:
        return _sha256(self.build_manifest_path)


@pytest.fixture
def reuse_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _ReuseFixture:
    fixture = _ReuseFixture(tmp_path)

    def verify_snapshot(_record: str, _build_root: str) -> dict[str, str]:
        return {
            "inventory_sha256": fixture.snapshot_inventory_sha256,
            "source_root": str(fixture.snapshot_root),
        }

    monkeypatch.setattr(build_snapshot, "verify_snapshot", verify_snapshot)
    return fixture


def _admit(fixture: _ReuseFixture, *, web_port: int = 0, expected: str | None = None):
    return storage._native_fem_interactive_frontend_reuse(
        fixture.layout, web_port, expected,
    )


def test_auto_port_reuses_saved_stage_and_pins_manifest(reuse_fixture: _ReuseFixture) -> None:
    identity, port = _admit(reuse_fixture)
    assert identity == reuse_fixture.build_manifest_sha256
    assert port == reuse_fixture.port

    same_identity, same_port = _admit(
        reuse_fixture,
        web_port=reuse_fixture.port,
        expected=identity,
    )
    assert (same_identity, same_port) == (identity, reuse_fixture.port)


def test_runtime_handoff_uses_reused_port_and_expected_build_id(
    reuse_fixture: _ReuseFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed: dict[str, object] = {}
    monkeypatch.setattr(storage, "_is_native_windows", lambda: True)
    monkeypatch.setattr(storage, "_validate_windows_fem_profile", lambda *_args: None)
    monkeypatch.setattr(
        storage,
        "_native_fem_authored_script",
        lambda *_args: (reuse_fixture.script_path, storage._sha256_file(reuse_fixture.script_path)),
    )
    monkeypatch.setattr(storage, "initialize", lambda _layout: None)
    monkeypatch.setattr(storage, "_publish_native_fem_receipt", lambda *_args: None)

    def run_managed(_layout, command, **_kwargs):
        observed["command"] = list(command)
        return 0

    monkeypatch.setattr(storage, "_run_managed_command", run_managed)
    result = storage.run_windows_fem(
        reuse_fixture.layout,
        frontend="dev",
        device="gpu",
        run_mode="interactive",
        script_path=reuse_fixture.script_path,
        output_dir=reuse_fixture.build_root / "runs" / "one",
        web_port=0,
        build_mode="false",
    )
    assert result == 0
    command = observed["command"]
    assert command[command.index("-WebPort") + 1] == str(reuse_fixture.port)
    assert command[command.index("-ExpectedBuildId") + 1] == reuse_fixture.build_manifest_sha256


def test_changed_source_manifest_hash_is_rejected(reuse_fixture: _ReuseFixture) -> None:
    reuse_fixture.stage_manifest_path.write_text("{}\n", encoding="utf-8")
    with pytest.raises(storage.StorageError, match="source manifest hash is stale"):
        _admit(reuse_fixture)


def test_stale_frozen_snapshot_is_rejected(
    reuse_fixture: _ReuseFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        build_snapshot,
        "verify_snapshot",
        lambda *_args: {
            "inventory_sha256": "c" * 64,
            "source_root": str(reuse_fixture.snapshot_root),
        },
    )
    with pytest.raises(storage.StorageError, match="frozen source binding"):
        _admit(reuse_fixture)


def test_stage_outside_build_root_is_rejected(
    reuse_fixture: _ReuseFixture, tmp_path: Path
) -> None:
    reuse_fixture._write_stage(workspace_root=str(tmp_path / "outside"))
    with pytest.raises(storage.StorageError, match="contained"):
        _admit(reuse_fixture)


def test_reparse_cache_parent_is_rejected(
    reuse_fixture: _ReuseFixture, tmp_path: Path
) -> None:
    outside = tmp_path / "outside-next"
    outside.mkdir()
    shutil.rmtree(reuse_fixture.cache_root / "next")
    (reuse_fixture.cache_root / "next").symlink_to(outside, target_is_directory=True)
    with pytest.raises(storage.StorageError, match="symlink/junction"):
        _admit(reuse_fixture)


def test_missing_saved_port_is_rejected(reuse_fixture: _ReuseFixture) -> None:
    reuse_fixture._write_stage(web_port=None)
    with pytest.raises(storage.StorageError, match="valid saved web port"):
        _admit(reuse_fixture)


def test_explicit_different_port_is_rejected(reuse_fixture: _ReuseFixture) -> None:
    with pytest.raises(storage.StorageError, match="rerun with build=True"):
        _admit(reuse_fixture, web_port=reuse_fixture.port + 1)


def test_manifest_identity_mismatch_is_rejected(reuse_fixture: _ReuseFixture) -> None:
    with pytest.raises(storage.StorageError, match="ExpectedBuildId"):
        _admit(reuse_fixture, expected="c" * 64)


def test_occupied_saved_port_is_rejected(reuse_fixture: _ReuseFixture) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        occupied.bind(("127.0.0.1", reuse_fixture.port))
        occupied.listen(1)
        with pytest.raises(storage.StorageError, match="occupied; refusing to kill or rebuild"):
            _admit(reuse_fixture)
