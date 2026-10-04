"""Bounded interpreted checks for private native dev status; no Rust compilation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from itertools import count
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fullmag_storage import atomic_json
from windows.development_status import (
    DevelopmentStatusError,
    DevelopmentStatusPublisher,
    StatusHeartbeat,
    make_publisher,
    verified_build_identity,
)
from windows.runtime_bundle import BINARY_NAMES, DECLARED_HASH_FIELDS, SOURCE_PATH_FIELDS
from windows.watch_backend import BuildWatcher, validate_debounce_seconds
from windows import watch_backend


GENERATION = "1" * 32
WORKTREE = "fullmag-0123456789abcdef"
SOURCE = "a" * 64


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


class DevelopmentStatusTests(unittest.TestCase):
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

    def test_default_waits_two_minutes_from_the_last_edit(self):
        current, builds = ["a"], []
        watcher = BuildWatcher(lambda: current[0], lambda: builds.append(current[0]) or 0, lambda _: None)
        watcher.step(0)
        current[0] = "b"
        watcher.step(60)
        watcher.step(179.9)
        self.assertEqual(builds, [])
        watcher.step(180)
        watcher.step(300)
        self.assertEqual(builds, ["b"])

    def test_debounce_window_is_bounded_and_zero_requires_once(self):
        self.assertEqual(validate_debounce_seconds("120", once=False), 120.0)
        self.assertEqual(validate_debounce_seconds("300", once=False), 300.0)
        self.assertEqual(validate_debounce_seconds("0", once=True), 0.0)
        for value in ("nan", "inf", "0.5", "301", "not-a-number"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_debounce_seconds(value, once=False)
        with self.assertRaises(ValueError):
            validate_debounce_seconds("0", once=False)

    def test_superseded_build_resets_full_quiet_window_before_retry(self):
        current = ["a"]
        builds = []
        states = []

        def build():
            builds.append(current[0])
            if current[0] == "a":
                current[0] = "b"
            return 0

        watcher = BuildWatcher(lambda: current[0], build, states.append)
        watcher.step(0)
        with patch("windows.watch_backend.time.monotonic", return_value=130):
            watcher.step(120)
        self.assertEqual(builds, ["a"])
        self.assertEqual(states[-1]["state"], "superseded")

        # The source changed during compilation. The retry window starts at
        # the post-build observation time, not at the earlier file edit.
        watcher.step(130)
        self.assertEqual(states[-1]["state"], "waiting")
        watcher.step(249.9)
        self.assertEqual(builds, ["a"])
        watcher.step(250)
        self.assertEqual(builds, ["a", "b"])

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

            def build():
                builds.append("build")
                build_started.set()
                if not release_build.wait(timeout=2):
                    raise AssertionError("Test did not release its controlled build")
                return 0

            watcher = BuildWatcher(
                lambda: SOURCE,
                build,
                publisher.publish,
                debounce=0,
                verify_ready=lambda source: {
                    "ready_build_id": "f" * 64,
                    "ready_source_sha256": source,
                },
            )
            worker = threading.Thread(target=lambda: watcher.step(0), daemon=True)
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
            self.assertEqual(builds, ["build"])
            self.assertNotIn("runtime_restart", final)

    def test_zero_exit_with_bad_or_mismatched_manifest_never_becomes_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root, runtime_root, manifest_path = _write_verified_manifest(Path(directory))
            verified = verified_build_identity(build_root, runtime_root, manifest_path, SOURCE)
            self.assertEqual(verified["ready_source_sha256"], SOURCE)
            self.assertRegex(verified["ready_build_id"], r"^[0-9a-f]{64}$")
            with self.assertRaises(DevelopmentStatusError):
                verified_build_identity(build_root, runtime_root, manifest_path, "e" * 64)

            status_path = Path(directory) / "status.json"
            publisher = DevelopmentStatusPublisher(status_path, GENERATION, WORKTREE)
            current = [SOURCE]
            watcher = BuildWatcher(
                lambda: current[0],
                lambda: 0,
                publisher.publish,
                debounce=1,
                verify_ready=lambda source: verified_build_identity(
                    build_root, runtime_root, manifest_path, "e" * 64
                ),
            )
            watcher.step(0)
            self.assertEqual(json.loads(status_path.read_text(encoding="utf-8"))["state"], "waiting")
            watcher.step(1)
            final = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(watcher.last_result, 0)
            self.assertIsNotNone(watcher.last_validation_error)
            self.assertEqual(final["state"], "failed")
            self.assertNotIn("ready_build_id", final)
            self.assertNotIn("ready_source_sha256", final)

            binary = runtime_root.parent / "build" / "cargo-target" / "x86_64-pc-windows-msvc" / "backend-dev" / BINARY_NAMES[0]
            binary.write_bytes(b"changed-after-manifest")
            with self.assertRaises(DevelopmentStatusError):
                verified_build_identity(build_root, runtime_root, manifest_path, SOURCE)


if __name__ == "__main__":
    unittest.main()
