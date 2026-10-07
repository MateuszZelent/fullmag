"""Bounded interpreted checks for private native dev status; no Rust compilation."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from itertools import count
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fullmag_storage import atomic_json
import fullmag_storage as storage
from windows import development_handoff as capsule
from windows.development_status import (
    DevelopmentStatusError,
    DevelopmentStatusPublisher,
    StatusHeartbeat,
    make_publisher,
    verified_build_identity,
)
from windows.runtime_bundle import BINARY_NAMES, DECLARED_HASH_FIELDS, SOURCE_PATH_FIELDS
from windows.watch_backend import BuildWatcher
from windows import watch_backend
from windows import build_snapshot, select_development_candidate as selector


GENERATION = "1" * 32
WORKTREE = "fullmag-0123456789abcdef"
SOURCE = "a" * 64
REQUEST_ID = "12345678-1234-4234-8234-123456789abc"


def _write_verified_manifest(root: Path, *, source_sha256: str = SOURCE) -> tuple[Path, Path, Path]:
    build_root = root / "build"
    runtime_root = root / "runtime"
    build_root.mkdir()
    runtime_root.mkdir()
    git_commit = "d" * 40
    snapshot = "b" * 64
    target_root = build_root / "cargo-target"
    profile_root = target_root / "x86_64-pc-windows-msvc" / "backend-dev"
    profile_root.mkdir(parents=True)
    binaries = {}
    executable_hashes = {}
    for name in BINARY_NAMES:
        binary_path = profile_root / name
        binary_path.write_bytes(("verified:" + name).encode("utf-8"))
        digest = hashlib.sha256(binary_path.read_bytes()).hexdigest()
        executable_hashes[name] = digest
        if name in SOURCE_PATH_FIELDS:
            binaries[SOURCE_PATH_FIELDS[name]] = str(binary_path)

    manifest = {
        "schema_version": 1,
        "target_triple": "x86_64-pc-windows-msvc",
        "compiler_profile": "backend-dev",
        "cuda": False,
        "features": [],
        "git_commit": git_commit,
        "source_snapshot_sha256": snapshot,
        "backend_source_sha256": source_sha256,
        "dependency_source_sha256": "c" * 64,
        "workspace_namespace": "fullmag-test",
        "cargo_target_dir": str(target_root),
        "build_version": {
            "schema": "fullmag.build-version.v1",
            "git_commit": git_commit,
            "source_snapshot_sha256": snapshot,
            "product_version": "1.2.3-dev.20261003.gdddddddd",
        },
        "frontend_mode": "dev",
        "source_identity_check": "passed",
        "local_changes_check": "enforced",
        "executable_sha256": executable_hashes,
        **binaries,
    }
    for binary_name, field in DECLARED_HASH_FIELDS.items():
        manifest[field] = executable_hashes[binary_name]
    manifest_path = build_root / "windows-runtime" / "build-manifest.json"
    manifest_path.parent.mkdir()
    manifest_path.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
    return build_root, runtime_root, manifest_path


def _write_snapshot_verified_manifest(root: Path) -> tuple[Path, Path, Path, Path, dict]:
    build_root, runtime_root, manifest_path = _write_verified_manifest(root)
    repo = root / "origin"
    repo.mkdir()
    (repo / "Cargo.toml").write_text("[workspace]\nmembers = []\n", encoding="utf-8")
    source_file = repo / "crates" / "demo" / "src" / "lib.rs"
    source_file.parent.mkdir(parents=True)
    source_file.write_bytes(b"pub const FIXTURE: u8 = 1;\n")
    subprocess.check_call(["git", "-C", str(repo), "init", "-q"])
    subprocess.check_call(["git", "-C", str(repo), "config", "user.email", "snapshot@example.invalid"])
    subprocess.check_call(["git", "-C", str(repo), "config", "user.name", "Snapshot fixture"])
    subprocess.check_call(["git", "-C", str(repo), "add", "."])
    subprocess.check_call(["git", "-C", str(repo), "commit", "-qm", "fixture"])
    frozen = build_snapshot.create_snapshot(repo, build_root)
    identity = frozen["source_identity"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.update(
        git_commit=identity["head_commit_full"],
        source_snapshot_sha256=identity["source_snapshot_sha256"],
        workspace_namespace=frozen["origin_worktree_id"],
        backend_source_sha256=frozen["backend_source_sha256"],
        dependency_source_sha256=frozen["dependency_source_sha256"],
        worktree_state="dirty" if identity["source_snapshot_dirty"] else "clean",
        source_commit_after=identity["head_commit_full"],
        source_snapshot_sha256_after=identity["source_snapshot_sha256"],
        source_worktree_state_after="dirty" if identity["source_snapshot_dirty"] else "clean",
        build_version={
            **manifest["build_version"],
            "git_commit": identity["head_commit_full"],
            "source_snapshot_sha256": identity["source_snapshot_sha256"],
        },
        build_source_snapshot={
            "record_path": frozen["record_path"],
            "inventory_sha256": frozen["inventory_sha256"],
            "source_root": frozen["source_root"],
        },
    )
    manifest_path.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
    # Snapshot files are sealed read-only by the production writer. Keep this
    # temporary test fixture removable on Windows after its integrity checks.
    for path in (build_root / "source-snapshots").rglob("*"):
        if path.is_file():
            path.chmod(0o600)
    return build_root, runtime_root, manifest_path, repo, frozen


class DevelopmentStatusTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows atomic rename contract")
    def test_transient_windows_rename_denial_keeps_status_publisher_alive(self):
        for code in (5, 32, 33):
            with self.subTest(winerror=code), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "status.json"
                publisher = DevelopmentStatusPublisher(path, GENERATION, WORKTREE)
                publisher.publish({"state": "waiting", "source_sha256": SOURCE})
                original_replace = os.replace
                denied = PermissionError("transient rename denial")
                denied.winerror = code
                calls = 0
                def replace_after_denial(source, target):
                    nonlocal calls
                    calls += 1
                    if calls <= 2:
                        raise denied
                    return original_replace(source, target)
                with patch.object(storage.os, "replace", side_effect=replace_after_denial), \
                        patch.object(storage.time, "sleep"):
                    refreshed = publisher.heartbeat()
                self.assertEqual(calls, 3)
                self.assertEqual(json.loads(path.read_text()), refreshed)
                self.assertEqual(publisher.heartbeat()["revision"], refreshed["revision"])
                self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    @unittest.skipUnless(os.name == "nt", "Windows atomic rename contract")
    def test_persistent_windows_rename_denial_still_stops_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            publisher = DevelopmentStatusPublisher(path, GENERATION, WORKTREE)
            publisher.publish({"state": "waiting", "source_sha256": SOURCE})
            prior = path.read_bytes()
            denied = PermissionError("persistent rename denial")
            denied.winerror = 5
            with patch.object(storage.os, "replace", side_effect=denied) as replace, \
                    patch.object(storage.time, "monotonic", side_effect=[0, 0, 1]), \
                    patch.object(storage.time, "sleep"):
                with self.assertRaises(PermissionError):
                    publisher.heartbeat()
                self.assertEqual(replace.call_count, 2)
                with self.assertRaises(DevelopmentStatusError):
                    publisher.heartbeat()
                self.assertEqual(replace.call_count, 2)
            self.assertEqual(path.read_bytes(), prior)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_failed_heartbeat_stops_consumer_before_reading_or_building_requests(self):
        from contextlib import nullcontext

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout = dict(storage_root=str(root), runtime_root=str(root / "runtime"),
                          build_root=str(root / "build"), repo_root=str(root),
                          profile="windows-native-fdm-cpu-dev", worktree_id=WORKTREE)
            with patch.object(watch_backend.sys, "platform", "win32"), \
                    patch.object(watch_backend, "resolve_layout", return_value=layout), \
                    patch.object(watch_backend, "validate_path", side_effect=lambda path, *_: Path(path)), \
                    patch.object(watch_backend, "file_lock", side_effect=lambda *_: nullcontext()), \
                    patch.object(watch_backend, "make_publisher"), \
                    patch.object(watch_backend, "StatusHeartbeat") as heartbeat_class, \
                    patch.object(watch_backend, "read_build_request") as read_request, \
                    patch.object(watch_backend.BuildWatcher, "step") as step:
                heartbeat = heartbeat_class.return_value.start.return_value
                heartbeat.raise_if_failed.side_effect = DevelopmentStatusError("heartbeat failed")
                with self.assertRaisesRegex(DevelopmentStatusError, "heartbeat failed"):
                    watch_backend.main(["--repo-root", str(root), "--generation-id", GENERATION,
                                        "--baseline-digest", SOURCE])
                read_request.assert_not_called()
                step.assert_not_called()
                heartbeat.stop.assert_called_once()

    def test_managed_identity_validation_does_not_require_a_stop_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout = dict(storage_root=str(root), runtime_root=str(root / "runtime"),
                          build_root=str(root / "build"), repo_root=str(root),
                          profile="windows-native-fdm-cpu-dev", worktree_id=WORKTREE)
            with patch.object(watch_backend, "resolve_layout", return_value=layout), \
                    patch.object(watch_backend, "validate_path", side_effect=lambda path, *_: Path(path)), \
                    patch.object(watch_backend, "make_publisher", side_effect=RuntimeError("publication boundary")):
                with self.assertRaisesRegex(RuntimeError, "publication boundary"):
                    watch_backend.main(["--repo-root", str(root), "--generation-id", GENERATION,
                                        "--baseline-digest", SOURCE])

    def test_standalone_watcher_without_generation_cannot_publish_api_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backend-watch-status.json"
            self.assertIsNone(make_publisher(path, None, WORKTREE))
            self.assertFalse(path.exists())
            with self.assertRaises(DevelopmentStatusError):
                make_publisher(path, "untrusted", WORKTREE)

    def test_revision_changes_with_state_and_heartbeat_keeps_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backend-watch-status.json"
            clock = count(1000)
            publisher = DevelopmentStatusPublisher(path, GENERATION, WORKTREE, clock_ms=lambda: next(clock))
            waiting = publisher.publish({"state": "waiting", "source_sha256": SOURCE})
            heartbeat = publisher.heartbeat()
            building = publisher.publish({"state": "building", "source_sha256": SOURCE})
            ready = publisher.publish({
                "state": "ready",
                "source_sha256": SOURCE,
                "ready_build_id": "e" * 64,
                "ready_source_sha256": SOURCE,
                "exit_code": 0,
                "runtime_restart": "manual_after_saving",
            })

            self.assertEqual(waiting["revision"], heartbeat["revision"])
            self.assertGreater(heartbeat["updated_unix_ms"], waiting["updated_unix_ms"])
            self.assertEqual(building["revision"], waiting["revision"] + 1)
            self.assertEqual(ready["revision"], building["revision"] + 1)
            self.assertEqual(ready["ready_build_id"], "e" * 64)
            self.assertNotIn("runtime_restart", ready)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), ready)
            self.assertEqual(set(ready), {
                "schema", "generation_id", "worktree_id", "state", "source_sha256",
                "revision", "updated_unix_ms", "ready_build_id", "ready_source_sha256",
            })

    def test_heartbeat_refreshes_status_while_build_is_blocked_without_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backend-watch-status.json"
            building_seen = threading.Event()
            heartbeat_seen = threading.Event()
            build_started = threading.Event()
            release_build = threading.Event()
            writes = []
            clock = count(1000)

            def write_json(target, document):
                atomic_json(target, document)
                if document["state"] == "building":
                    writes.append(document)
                    if len(writes) == 1:
                        building_seen.set()
                    elif document["updated_unix_ms"] > writes[0]["updated_unix_ms"]:
                        heartbeat_seen.set()

            publisher = DevelopmentStatusPublisher(
                path, GENERATION, WORKTREE, clock_ms=lambda: next(clock), write_json=write_json
            )
            publisher.publish({"state": "waiting", "source_sha256": SOURCE})
            heartbeat = StatusHeartbeat(publisher, interval_seconds=0.005).start()
            builds = []

            def build(request_id):
                builds.append(request_id)
                build_started.set()
                if not release_build.wait(timeout=2):
                    raise AssertionError("Test did not release its controlled build")
                return 0

            def verify_ready(expected_manifest_sha256):
                self.assertEqual(expected_manifest_sha256, "f" * 64)
                return {"ready_build_id": "f" * 64, "ready_source_sha256": SOURCE}

            watcher = BuildWatcher(
                lambda: SOURCE,
                build,
                publisher.publish,
                verify_ready=verify_ready,
                read_build_manifest_sha256=lambda request_id: "f" * 64,
            )
            worker = threading.Thread(target=lambda: watcher.step(0, REQUEST_ID), daemon=True)
            try:
                worker.start()
                self.assertTrue(build_started.wait(timeout=1))
                self.assertTrue(building_seen.wait(timeout=1))
                self.assertTrue(heartbeat_seen.wait(timeout=1))
                during_build = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(during_build["state"], "building")
                self.assertEqual(during_build["revision"], writes[0]["revision"])
                self.assertGreater(during_build["updated_unix_ms"], writes[0]["updated_unix_ms"])
            finally:
                release_build.set()
                worker.join(timeout=2)
                heartbeat.stop()
            self.assertFalse(worker.is_alive())
            heartbeat.raise_if_failed()
            final = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(final["state"], "ready")
            self.assertEqual(final["revision"], during_build["revision"] + 1)
            self.assertEqual(builds, [REQUEST_ID])
            self.assertNotIn("runtime_restart", final)

    def test_zero_exit_with_bad_or_mismatched_manifest_never_becomes_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root, runtime_root, manifest_path = _write_verified_manifest(Path(directory))
            verified = verified_build_identity(build_root, runtime_root, manifest_path, SOURCE)
            self.assertEqual(verified["ready_source_sha256"], SOURCE)
            self.assertRegex(verified["ready_build_id"], r"^[0-9a-f]{64}$")
            self.assertEqual(
                verified_build_identity(
                    build_root, runtime_root, manifest_path, SOURCE,
                    expected_manifest_sha256=verified["ready_build_id"],
                ),
                verified,
            )
            with self.assertRaises(DevelopmentStatusError):
                verified_build_identity(build_root, runtime_root, manifest_path, "e" * 64)

            status_path = Path(directory) / "status.json"
            publisher = DevelopmentStatusPublisher(status_path, GENERATION, WORKTREE)
            current = [SOURCE]
            watcher = BuildWatcher(
                lambda: current[0],
                lambda request_id: 0,
                publisher.publish,
                verify_ready=lambda expected_manifest: verified_build_identity(
                    build_root, runtime_root, manifest_path, "e" * 64,
                    expected_manifest_sha256=expected_manifest,
                ),
                read_build_manifest_sha256=lambda request_id: hashlib.sha256(
                    manifest_path.read_bytes()
                ).hexdigest(),
            )
            watcher.step(0, REQUEST_ID)
            final = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(watcher.last_result, 0)
            self.assertIsNotNone(watcher.last_validation_error)
            self.assertEqual(final["state"], "failed")
            self.assertEqual(final["request_id"], REQUEST_ID)
            self.assertNotIn("ready_build_id", final)
            self.assertNotIn("ready_source_sha256", final)

            binary = runtime_root.parent / "build" / "cargo-target" / "x86_64-pc-windows-msvc" / "backend-dev" / BINARY_NAMES[0]
            binary.write_bytes(b"changed-after-manifest")
            with self.assertRaises(DevelopmentStatusError):
                verified_build_identity(build_root, runtime_root, manifest_path, SOURCE)

    def test_manifest_pin_rejects_a_later_valid_b_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root, runtime_root, manifest_path = _write_verified_manifest(Path(directory))
            raw_a = manifest_path.read_bytes()
            pin_a = hashlib.sha256(raw_a).hexdigest()
            # The parsed manifest and binaries remain valid, but the raw bytes
            # now identify a different build than the receipt for request A.
            manifest_path.write_bytes(raw_a + b"\n")
            with self.assertRaisesRegex(DevelopmentStatusError, "changed after"):
                verified_build_identity(
                    build_root, runtime_root, manifest_path, SOURCE,
                    expected_manifest_sha256=pin_a,
                )

            status_path = Path(directory) / "status.json"
            publisher = DevelopmentStatusPublisher(status_path, GENERATION, WORKTREE)
            watcher = BuildWatcher(
                lambda: SOURCE,
                lambda request_id: 0,
                publisher.publish,
                verify_ready=lambda receipt_pin: verified_build_identity(
                    build_root, runtime_root, manifest_path, SOURCE,
                    expected_manifest_sha256=receipt_pin,
                ),
                read_build_manifest_sha256=lambda request_id: pin_a,
            )
            watcher.step(0, REQUEST_ID)
            final = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(final["state"], "failed")
            self.assertNotIn("ready_build_id", final)
            self.assertNotIn("ready_source_sha256", final)

    def test_snapshot_identity_survives_origin_edits_and_matches_ready_status(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root, runtime_root, manifest_path, repo, frozen = _write_snapshot_verified_manifest(
                Path(directory)
            )
            expected_source = frozen["backend_source_sha256"]
            (repo / "crates" / "demo" / "src" / "lib.rs").write_text(
                "pub const FIXTURE: u8 = 2;\n", encoding="utf-8"
            )
            identity = verified_build_identity(build_root, runtime_root, manifest_path, None)
            self.assertEqual(identity["ready_source_sha256"], expected_source)

            status = {"source_sha256": expected_source, "ready_source_sha256": expected_source}
            verified = selector._verified_build_source_snapshot(
                build_root,
                build_root.parent,
                manifest_path,
                identity["ready_build_id"],
                status,
            )
            self.assertEqual(verified, frozen)
            with self.assertRaises(capsule.HandoffError):
                selector._verified_build_source_snapshot(
                    build_root,
                    build_root.parent,
                    manifest_path,
                    identity["ready_build_id"],
                    {"source_sha256": "e" * 64, "ready_source_sha256": expected_source},
                )

    def test_private_ready_status_accepts_only_canonical_optional_request_ids(self):
        valid_status = {
            "schema": "fullmag.backend-watch.v2",
            "generation_id": GENERATION,
            "worktree_id": WORKTREE,
            "state": "ready",
            "source_sha256": SOURCE,
            "ready_build_id": "b" * 64,
            "ready_source_sha256": SOURCE,
            "revision": 1,
            "updated_unix_ms": 1000,
        }
        self.assertEqual(selector._validate_ready_status_document(valid_status, 1000), valid_status)
        self.assertEqual(
            selector._validate_ready_status_document(
                {**valid_status, "request_id": REQUEST_ID}, 1000
            )["request_id"],
            REQUEST_ID,
        )
        for request_id in ("0" * 32, REQUEST_ID.upper(), "not-a-uuid", None):
            with self.subTest(request_id=request_id), self.assertRaises(capsule.HandoffError):
                selector._validate_ready_status_document(
                    {**valid_status, "request_id": request_id}, 1000
                )


if __name__ == "__main__":
    unittest.main()
