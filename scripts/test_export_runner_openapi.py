#!/usr/bin/env python3
"""Interpreted regressions for the managed package OpenAPI export boundary."""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import export_runner_openapi as exporter
from local_runner.build_entrypoint import HEADLESS_REQUIRED_OUTPUTS, required_outputs_for_profile
from local_runner.worker_entrypoint import canonical


COMMIT = "a" * 40
SNAPSHOT = "b" * 64
SOURCE_DIGEST = "c" * 64
IMAGE = "sha256:" + "d" * 64
WORKTREE = "fixture-worktree"
JOB_ID = "e" * 32


class Fixture:
    def __init__(self, profile: str = "fem-cpu-release", *,
                 outputs: tuple[str, ...] | None = None) -> None:
        self.profile = profile
        self.outputs = required_outputs_for_profile(profile) if outputs is None else outputs
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-openapi-export-")
        root = Path(self.temp.name)
        self.storage = root / "storage"
        self.run_root = self.storage / "runs" / WORKTREE / JOB_ID
        self.capsule = self.storage / "runs" / WORKTREE / ("f" * 32) / "source"
        self.package = self.run_root / "artifacts" / "outputs" / ".fullmag" / "local"
        self.layout = {
            "storage_root": str(self.storage),
            "build_storage_root": str(self.storage),
            "runs_root": str(self.storage / "runs" / WORKTREE),
            "build_root": str(self.storage / "builds" / WORKTREE / self.profile),
            "worktree_id": WORKTREE,
        }
        self._write_source()
        self._write_build()
        self._write_queue()

    def close(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def _write(path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def _native_identity(self) -> dict[str, object]:
        payload = {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": COMMIT,
            "head_tree_sha256": "1" * 64,
            "git_status_porcelain_v1": [],
            "dirty_path_content": [],
            "ignored_non_runtime_dirty": True,
        }
        return {
            **payload,
            "source_snapshot_dirty": False,
            "dirty_content_sha256": hashlib.sha256(canonical([])).hexdigest(),
            "source_snapshot_sha256": hashlib.sha256(canonical(payload)).hexdigest(),
        }

    def _write_source(self) -> None:
        file_bytes = b"managed source fixture\n"
        relative = "README.md"
        self._write(self.capsule / "tree" / relative, file_bytes)
        core = {
            "schema_version": "fullmag.source-capsule.v1",
            "source_mode": "commit",
            "resolved_commit": COMMIT,
            "files": [{"path": relative, "type": "file", "mode": "100644",
                       "size": len(file_bytes), "sha256": hashlib.sha256(file_bytes).hexdigest()}],
            "deleted": [],
            "included_untracked": [],
            "excluded": [],
        }
        manifest = {**core, "source_digest": hashlib.sha256(canonical(core)).hexdigest()}
        self._write(self.capsule / "manifest.json", json.dumps(manifest).encode())
        self.source_manifest = manifest

    def _write_build(self) -> None:
        native = self._native_identity()
        self.run_root.mkdir(parents=True)
        trusted = self.run_root / "trusted"
        trusted.mkdir()
        context = {
            "schema": "fullmag.runner-execution.v1",
            "job_id": JOB_ID,
            "source_digest": self.source_manifest["source_digest"],
            "profile": self.profile,
            "image_digest": IMAGE,
            "native_source_identity": native,
        }
        self._write(trusted / "build_entrypoint.py", b"fixture build entrypoint")
        self._write(trusted / "worker_entrypoint.py", b"fixture worker entrypoint")
        self._write(trusted / "context.json", (json.dumps(context) + "\n").encode())
        trusted_hashes = {name: hashlib.sha256((trusted / name).read_bytes()).hexdigest()
                          for name in ("context.json", "build_entrypoint.py", "worker_entrypoint.py")}
        artifacts = self.run_root / "artifacts"
        output = self.package
        entries = []
        for index, relative in enumerate(self.outputs):
            content = (f"fixture-{index}\n").encode()
            path = output.joinpath(*relative.split("/"))
            self._write(path, content)
            entries.append({"path": "outputs/.fullmag/local/" + relative,
                            "size": len(content),
                            "sha256": hashlib.sha256(content).hexdigest()})
        receipt = {
            "schema": "fullmag.local-runner.build-receipt.v1",
            "job_id": JOB_ID,
            "source_digest": self.source_manifest["source_digest"],
            "profile": self.profile,
            "state": "succeeded",
            "qualification": "NOT VERIFIED",
            "image_digest": IMAGE,
            "native_source_identity": native,
            "native_source_identity_sha256": hashlib.sha256(canonical(native)).hexdigest(),
            "artifacts": entries,
            "stages": [{"name": name, "exit_code": 0} for name in
                        ("native-build", "frontend-dependencies", "frontend-build")],
        }
        if self.profile.startswith("fem-cpu-slepc-runtime-"):
            receipt["runtime_only"] = True
            receipt["stages"] = [{"name": "native-build", "exit_code": 0}]
        self._write(artifacts / "build-receipt.json", (json.dumps(receipt) + "\n").encode())
        journal = {
            "schema": "fullmag.local-runner.coordinator.v1",
            "job_id": JOB_ID,
            "owner": "fixture",
            "operation": "build",
            "profile": self.profile,
            "source_digest": self.source_manifest["source_digest"],
            "image_digest": IMAGE,
            "mounts": [["bind", str(self.capsule), "/source", False]],
            "trusted_hashes": trusted_hashes,
            "phase": "terminal",
            "state": "succeeded",
            "exit_code": 0,
        }
        self._write(self.run_root / "receipt.json", (json.dumps(journal) + "\n").encode())
        self.journal = journal
        self.context = context

    def _write_queue(self) -> None:
        index = self.storage / "index"
        index.mkdir(parents=True, exist_ok=True)
        database = sqlite3.connect(index / "runner-jobs.sqlite")
        database.execute("""CREATE TABLE jobs (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
            request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
            worktree_id TEXT NOT NULL, source_digest TEXT NOT NULL,
            profile TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL,
            state TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
            coordinator TEXT, lease_token TEXT, exit_code INTEGER)""")
        payload = {
            "capture_id": "f" * 32,
            "capsule_relative": f"runs/{WORKTREE}/{'f' * 32}/source",
            "origin_repo": "C:/fixture/fullmag",
            "native_source_identity": self.context["native_source_identity"],
        }
        database.execute(
            "INSERT INTO jobs (job_id,owner,request_key,request_hash,worktree_id,source_digest,"
            "profile,operation,payload,state,created_at,updated_at,exit_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (JOB_ID, "fixture", "request", "0" * 64, WORKTREE, self.source_manifest["source_digest"],
             self.profile, "build", json.dumps(payload), "succeeded", 1, 1, 0),
        )
        database.commit()
        database.close()


class ExportRunnerOpenApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def _image(self, _digest: str) -> dict[str, object]:
        return {"Id": IMAGE, "Config": {}}

    def _capture(self, command):
        self.command = list(command)
        document = {
            "openapi": "3.1.0",
            "paths": {exporter.OPENAPI_ROUTE: {"get": {"responses": {"200": {}}}}},
            "x-fullmag-build-identity": {
                "built_at_utc": "2026-10-03T12:00:00Z",
                "git_commit": COMMIT,
                "worktree_state": "clean",
                "source_snapshot_sha256": self.fixture.context["native_source_identity"]["source_snapshot_sha256"],
            },
        }
        return exporter.ProcessCapture(0, (json.dumps(document) + "\n").encode(), b"startup\n", False, False,
                                       started=True)

    def test_success_uses_existing_validators_and_networkless_direct_binary(self) -> None:
        before = sorted(path.relative_to(self.fixture.package).as_posix()
                        for path in self.fixture.package.rglob("*"))
        evidence = exporter.export_openapi(
            Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
            layout=self.fixture.layout, image_inspect=self._image, capture=self._capture,
        )
        self.assertTrue((evidence / "receipt.json").is_file())
        self.assertTrue((evidence / "proof.json").is_file())
        self.assertGreater((evidence / "stdout.raw.json").stat().st_size, 0)
        self.assertIn("--network=none", self.command)
        self.assertIn("--read-only", self.command)
        self.assertEqual(self.command[self.command.index("--cap-drop") + 1], "ALL")
        self.assertIn("no-new-privileges:true", self.command)
        self.assertEqual(self.command[self.command.index("--entrypoint") + 1], "/package/bin/fullmag-api")
        self.assertEqual(self.command[-2:], [IMAGE, "--print-openapi-v2"])
        self.assertNotIn("bash", self.command)
        self.assertEqual(before, sorted(path.relative_to(self.fixture.package).as_posix()
                                        for path in self.fixture.package.rglob("*")))

    def test_runtime_profile_exports_without_full_release_or_frontend(self) -> None:
        self.fixture.close()
        self.fixture = Fixture("fem-cpu-slepc-runtime-v2", outputs=HEADLESS_REQUIRED_OUTPUTS)
        receipt = json.loads((self.fixture.run_root / "artifacts" / "build-receipt.json").read_text())
        self.assertFalse((self.fixture.package / "web" / "index.html").exists())
        self.assertLess(len(self.fixture.outputs), 15)
        # Isolate the export consumer from runtime-attestation fixtures. The
        # build executor owns those invariants and must still validate first.
        with patch.object(exporter, "validate_build_receipt", return_value=receipt) as validate:
            evidence = exporter.export_openapi(
                Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
                layout=self.fixture.layout, image_inspect=self._image, capture=self._capture,
            )
        validate.assert_called_once()
        self.assertEqual(validate.call_args.args[1]["profile"], "fem-cpu-slepc-runtime-v2")
        proof = json.loads((evidence / "proof.json").read_text())
        self.assertTrue((evidence / "stdout.raw.json").stat().st_size > 0)
        self.assertTrue(proof)
        self.assertIn("--network=none", self.command)
        self.assertIn("--read-only", self.command)
        library_path = next(value.split("=", 1)[1] for value in self.command
                            if value.startswith("LD_LIBRARY_PATH="))
        self.assertEqual(library_path.split(":")[0], "/package/lib")
        self.assertIn("/opt/fullmag-mfem-cpu/lib", library_path.split(":"))

    def test_unknown_profile_cannot_choose_library_environment(self) -> None:
        build = exporter._validate_managed_build(self.fixture.layout, JOB_ID, COMMIT)
        with patch.object(exporter, "PROFILES", {}, create=True):
            with self.assertRaisesRegex(exporter.ExportError, "profile is not recognized"):
                exporter.docker_run_argv(build, "1" * 32)

    def test_invalid_runtime_receipt_is_rejected_before_capture(self) -> None:
        self.fixture.close()
        self.fixture = Fixture("fem-cpu-slepc-runtime-v2", outputs=HEADLESS_REQUIRED_OUTPUTS)
        with patch.object(exporter, "validate_build_receipt", side_effect=ValueError("invalid runtime attestation")) as validate:
            with patch.object(exporter, "_capture") as capture:
                with self.assertRaisesRegex(ValueError, "invalid runtime attestation"):
                    exporter._validate_managed_build(self.fixture.layout, JOB_ID, COMMIT)
        validate.assert_called_once()
        capture.assert_not_called()

    def test_profile_without_declared_api_binary_is_rejected(self) -> None:
        declared = tuple(output for output in required_outputs_for_profile(self.fixture.profile)
                         if output != "bin/fullmag-api")
        self.assertGreaterEqual(len(declared), 14)
        with patch.object(exporter, "required_outputs_for_profile", return_value=declared):
            with self.assertRaisesRegex(exporter.ExportError, "does not declare the fullmag-api output"):
                exporter._validate_managed_build(self.fixture.layout, JOB_ID, COMMIT)

    def test_incomplete_release_receipt_is_still_rejected(self) -> None:
        receipt_path = self.fixture.run_root / "artifacts" / "build-receipt.json"
        receipt = json.loads(receipt_path.read_text())
        receipt["artifacts"] = [entry for entry in receipt["artifacts"]
                                if entry["path"] != "outputs/.fullmag/local/web/index.html"]
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Required build outputs missing"):
            exporter._validate_managed_build(self.fixture.layout, JOB_ID, COMMIT)

    def test_nonterminal_queue_is_rejected_before_package_access(self) -> None:
        database = sqlite3.connect(self.fixture.storage / "index" / "runner-jobs.sqlite")
        database.execute("UPDATE jobs SET state='running' WHERE job_id=?", (JOB_ID,))
        database.commit()
        database.close()
        with self.assertRaises(exporter.ExportError):
            exporter._validate_managed_build(self.fixture.layout, JOB_ID, COMMIT)

    def test_dirty_source_identity_is_fail_closed(self) -> None:
        native = dict(self.fixture.context["native_source_identity"])
        native["source_snapshot_dirty"] = True
        with self.assertRaises(exporter.ExportError):
            exporter._validate_native_identity(native, COMMIT)

    def test_stale_openapi_identity_is_retained_as_failed_evidence(self) -> None:
        def stale(_command):
            document = {
                "paths": {exporter.OPENAPI_ROUTE: {}},
                "x-fullmag-build-identity": {
                    "built_at_utc": "2026-10-03T12:00:00Z",
                    "git_commit": "0" * 40,
                    "worktree_state": "clean",
                    "source_snapshot_sha256": SNAPSHOT,
                },
            }
            return exporter.ProcessCapture(0, json.dumps(document).encode(), b"", False, False,
                                           started=True)

        with self.assertRaises(exporter.ExportError) as raised:
            exporter.export_openapi(
                Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
                layout=self.fixture.layout, image_inspect=self._image, capture=stale,
            )
        self.assertIn("evidence retained", str(raised.exception))

    def test_nonzero_export_is_retained_with_exit_and_raw_hashes(self) -> None:
        def failed(_command):
            return exporter.ProcessCapture(17, b"{}\n", b"fatal\n", False, False, started=True)

        with self.assertRaises(exporter.ExportError) as raised:
            exporter.export_openapi(
                Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
                layout=self.fixture.layout, image_inspect=self._image, capture=failed,
            )
        evidence = Path(str(raised.exception).rsplit(" at ", 1)[-1])
        receipt = json.loads((evidence / "receipt.json").read_text())
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["exit_code"], 17)
        self.assertEqual(receipt["raw_openapi_sha256"], hashlib.sha256((evidence / "stdout.raw.json").read_bytes()).hexdigest())
        self.assertEqual(receipt["stderr_sha256"], hashlib.sha256((evidence / "stderr.raw.log").read_bytes()).hexdigest())

    def test_capture_timeout_and_cleanup_are_bounded(self) -> None:
        class HangingProcess:
            stdout = io.BytesIO()
            stderr = io.BytesIO()

            def __init__(self):
                self.killed = False

            def poll(self):
                return -9 if self.killed else None

            def kill(self):
                self.killed = True

            def wait(self, timeout=None):
                return -9

        cleaned = []
        result = exporter._capture(
            ["docker"], timeout=0.001,
            popen=lambda *args, **kwargs: HangingProcess(),
            cleanup=lambda: (cleaned.append(True) or exporter.CleanupResult(True)),
        )
        self.assertTrue(result.timed_out)
        self.assertTrue(result.cleanup_confirmed)
        self.assertEqual(cleaned, [True])

    def test_capture_output_overflow_and_spawn_failure_are_recorded(self) -> None:
        class OutputProcess:
            stdout = io.BytesIO(b"123456")
            stderr = io.BytesIO(b"")

            def __init__(self):
                self.killed = False

            def poll(self):
                return -9 if self.killed else None

            def kill(self):
                self.killed = True

            def wait(self, timeout=None):
                return -9

        with patch.object(exporter, "MAX_STREAM_BYTES", 3):
            overflow = exporter._capture(
                ["docker"], popen=lambda *args, **kwargs: OutputProcess(),
                cleanup=lambda: exporter.CleanupResult(True),
            )
        self.assertTrue(overflow.output_limit_exceeded)
        self.assertTrue(overflow.cleanup_confirmed)
        cleaned = []
        spawned = exporter._capture(
            ["docker"],
            popen=lambda *args, **kwargs: (_ for _ in ()).throw(OSError("spawn denied")),
            cleanup=lambda: (cleaned.append(True) or exporter.CleanupResult(True)),
        )
        self.assertTrue(spawned.spawn_failed)
        self.assertEqual(cleaned, [True])

    def test_reader_failure_kills_cli_before_cleanup_and_pipe_close(self) -> None:
        events = []

        class BrokenStream:
            def read(self, _size):
                raise RuntimeError("reader boom")

            def close(self):
                events.append("close")

        class LiveProcess:
            def __init__(self):
                self.stdout = BrokenStream()
                self.stderr = io.BytesIO()
                self.killed = False

            def poll(self):
                return -9 if self.killed else None

            def kill(self):
                events.append("kill")
                self.killed = True

            def wait(self, timeout=None):
                events.append("wait")
                return -9

        result = exporter._capture(
            ["docker"], timeout=1,
            popen=lambda *args, **kwargs: LiveProcess(),
            cleanup=lambda: (events.append("cleanup") or exporter.CleanupResult(True)),
        )
        self.assertTrue(result.capture_failed)
        self.assertIn("reader boom", result.capture_detail or "")
        self.assertEqual(events[:3], ["kill", "wait", "cleanup"])
        self.assertIn("close", events[3:])

    def test_successful_capture_drains_delayed_readers_before_closing_pipes(self) -> None:
        events = []

        class DelayedStream:
            def __init__(self, payload):
                self.payload = payload
                self.reads = 0

            def read(self, _size):
                self.reads += 1
                if self.reads == 1:
                    time.sleep(0.03)
                    events.append("read-done")
                    return self.payload
                return b""

            def close(self):
                events.append("close")

        class CompletedProcess:
            def __init__(self):
                self.stdout = DelayedStream(b"complete stdout\n")
                self.stderr = DelayedStream(b"complete stderr\n")

            def poll(self):
                return 0

            def wait(self, timeout=None):
                return 0

        result = exporter._capture(
            ["docker"],
            timeout=1,
            popen=lambda *args, **kwargs: CompletedProcess(),
            cleanup=lambda: exporter.CleanupResult(True),
        )
        self.assertFalse(result.capture_failed)
        self.assertEqual(result.stdout, b"complete stdout\n")
        self.assertEqual(result.stderr, b"complete stderr\n")
        self.assertGreaterEqual(events.count("read-done"), 2)
        last_read = max(index for index, event in enumerate(events) if event == "read-done")
        first_close = min(index for index, event in enumerate(events) if event == "close")
        self.assertGreater(first_close, last_read)

    def test_unsettled_reader_is_bounded_and_pipe_remains_open(self) -> None:
        released = threading.Event()

        class BlockingStream:
            def __init__(self):
                self.closed = False

            def read(self, _size):
                released.wait()
                return b""

            def close(self):
                self.closed = True

        stdout = BlockingStream()

        class CompletedProcess:
            def __init__(self):
                self.stdout = stdout
                self.stderr = io.BytesIO()

            def poll(self):
                return 0

            def wait(self, timeout=None):
                return 0

        with patch.object(exporter, "READER_JOIN_TIMEOUT_SECONDS", 0.02):
            result = exporter._capture(
                ["docker"],
                timeout=1,
                popen=lambda *args, **kwargs: CompletedProcess(),
                cleanup=lambda: exporter.CleanupResult(True),
            )
        self.assertTrue(result.capture_failed)
        self.assertIn("reader thread did not settle", result.capture_detail or "")
        self.assertFalse(stdout.closed)
        released.set()

    def test_process_start_failure_creates_terminal_failed_receipt(self) -> None:
        with patch.object(exporter, "_docker_executable", return_value="docker"), \
                patch.object(exporter.subprocess, "Popen", side_effect=OSError("spawn denied")), \
                patch.object(exporter, "_cleanup_owned_container", return_value=exporter.CleanupResult(True)):
            with self.assertRaises(exporter.ExportError) as raised:
                exporter.export_openapi(
                    Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
                    layout=self.fixture.layout, image_inspect=self._image,
                )
        evidence = Path(str(raised.exception).rsplit(" at ", 1)[-1])
        receipt = json.loads((evidence / "receipt.json").read_text())
        self.assertEqual(receipt["state"], "failed")
        self.assertTrue(receipt["spawn_failed"])
        self.assertFalse(receipt["process_started"])
        self.assertTrue(receipt["cleanup_confirmed"])

    def test_post_start_input_tamper_fails_with_prevalidated_hashes(self) -> None:
        original_hash = hashlib.sha256((self.fixture.package / "bin" / "fullmag-api").read_bytes()).hexdigest()

        def tampering_capture(_command):
            (self.fixture.package / "bin" / "fullmag-api").write_bytes(b"tampered after start")
            return self._capture(_command)

        with self.assertRaises(exporter.ExportError) as raised:
            exporter.export_openapi(
                Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
                layout=self.fixture.layout, image_inspect=self._image, capture=tampering_capture,
            )
        evidence = Path(str(raised.exception).rsplit(" at ", 1)[-1])
        receipt = json.loads((evidence / "receipt.json").read_text())
        self.assertEqual(receipt["state"], "failed")
        self.assertFalse(receipt["input_hashes_verified"])
        self.assertEqual(receipt["api_binary_sha256"], original_hash)

    def test_post_start_missing_input_still_writes_failed_proof(self) -> None:
        def deleting_capture(_command):
            (self.fixture.package / "bin" / "fullmag-api").unlink()
            return self._capture(_command)

        with self.assertRaises(exporter.ExportError) as raised:
            exporter.export_openapi(
                Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
                layout=self.fixture.layout, image_inspect=self._image, capture=deleting_capture,
            )
        evidence = Path(str(raised.exception).rsplit(" at ", 1)[-1])
        self.assertTrue((evidence / "proof.json").is_file())
        receipt = json.loads((evidence / "receipt.json").read_text())
        self.assertEqual(receipt["state"], "failed")
        self.assertFalse(receipt["input_hashes_verified"])

    def test_missing_docker_still_leaves_terminal_failed_evidence(self) -> None:
        with patch.object(exporter.ManagedBuild, "input_hash_mismatches", autospec=True, return_value=[]) as checks, \
                patch.object(exporter, "_docker_executable", side_effect=exporter.ExportError("docker missing")):
            with self.assertRaises(exporter.ExportError) as raised:
                exporter.export_openapi(
                    Path("C:/fixture/fullmag"), JOB_ID, COMMIT,
                    layout=self.fixture.layout, image_inspect=self._image, capture=self._capture,
                )
        evidence = Path(str(raised.exception).rsplit(" at ", 1)[-1])
        self.assertTrue((evidence / "receipt.json").is_file())
        self.assertTrue((evidence / "proof.json").is_file())
        receipt = json.loads((evidence / "receipt.json").read_text())
        self.assertEqual(receipt["state"], "failed")
        self.assertFalse(receipt["process_started"])
        self.assertEqual(checks.call_count, 1)
        self.assertTrue(receipt["input_hashes_checked"])
        self.assertTrue(receipt["input_hashes_verified"])

    def test_reparse_ancestor_and_leaf_are_rejected(self) -> None:
        target = Path(self.fixture.temp.name) / "real"
        target.mkdir()
        ancestor = Path(self.fixture.temp.name) / "ancestor-link"
        leaf = Path(self.fixture.temp.name) / "leaf-link"
        try:
            ancestor.symlink_to(target, target_is_directory=True)
            leaf_target = target / "leaf"
            leaf_target.write_bytes(b"leaf")
            leaf.symlink_to(leaf_target)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlink fixture unavailable: {error}")
        with self.assertRaises(exporter.ExportError):
            exporter._preflight_ancestors(ancestor / "child", "ancestor fixture")
        with self.assertRaises(exporter.ExportError):
            exporter._preflight_ancestors(leaf, "leaf fixture")

    def test_cleanup_refuses_foreign_container_with_same_generated_name(self) -> None:
        identifier = "1" * 64
        responses = [
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([{
                "Id": identifier, "Image": IMAGE, "Name": "/fullmag-openapi-foreign",
                "Config": {"Labels": {"com.fullmag.fullmag-openapi-export": "other"}},
            }]), ""),
        ]
        with patch.object(exporter, "_docker_control", side_effect=responses) as control:
            result = exporter._cleanup_owned_container("fullmag-openapi-foreign", "expected", IMAGE)
        self.assertTrue(result.failed)
        self.assertEqual(control.call_count, 2)

    def test_cleanup_removes_only_owned_container_and_confirms_absence(self) -> None:
        identifier = "2" * 64
        owned = {
            "Id": identifier, "Image": IMAGE, "Name": "/fullmag-openapi-owned",
            "State": {"Running": True},
            "Config": {"Labels": {"com.fullmag.fullmag-openapi-export": "owned"}},
        }
        responses = [
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([owned]), ""),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([owned]), ""),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, "", ""),
        ]
        with patch.object(exporter, "_docker_control", side_effect=responses) as control:
            result = exporter._cleanup_owned_container("fullmag-openapi-owned", "owned", IMAGE)
        self.assertTrue(result.confirmed)
        self.assertFalse(result.failed)
        self.assertEqual(control.call_count, 7)

    def test_cleanup_stop_race_accepts_verified_absence(self) -> None:
        identifier = "3" * 64
        owned = {
            "Id": identifier, "Image": IMAGE, "Name": "/fullmag-openapi-stop-race",
            "State": {"Running": True},
            "Config": {"Labels": {"com.fullmag.fullmag-openapi-export": "stop-race"}},
        }
        responses = [
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([owned]), ""),
            subprocess.CompletedProcess([], 1, "", "No such container"),
            subprocess.CompletedProcess([], 0, "", ""),
        ]
        with patch.object(exporter, "_docker_control", side_effect=responses):
            result = exporter._cleanup_owned_container("fullmag-openapi-stop-race", "stop-race", IMAGE)
        self.assertTrue(result.confirmed)
        self.assertFalse(result.failed)

    def test_cleanup_remove_race_accepts_verified_absence(self) -> None:
        identifier = "4" * 64
        owned = {
            "Id": identifier, "Image": IMAGE, "Name": "/fullmag-openapi-remove-race",
            "State": {"Running": False},
            "Config": {"Labels": {"com.fullmag.fullmag-openapi-export": "remove-race"}},
        }
        responses = [
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([owned]), ""),
            subprocess.CompletedProcess([], 1, "", "No such container"),
            subprocess.CompletedProcess([], 0, "", ""),
        ]
        with patch.object(exporter, "_docker_control", side_effect=responses):
            result = exporter._cleanup_owned_container("fullmag-openapi-remove-race", "remove-race", IMAGE)
        self.assertTrue(result.confirmed)
        self.assertFalse(result.failed)

    def test_cleanup_remove_failure_with_owned_container_still_present_fails(self) -> None:
        identifier = "5" * 64
        owned = {
            "Id": identifier, "Image": IMAGE, "Name": "/fullmag-openapi-remove-stuck",
            "State": {"Running": False},
            "Config": {"Labels": {"com.fullmag.fullmag-openapi-export": "remove-stuck"}},
        }
        responses = [
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([owned]), ""),
            subprocess.CompletedProcess([], 1, "", "No such container"),
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([owned]), ""),
        ]
        with patch.object(exporter, "_docker_control", side_effect=responses):
            result = exporter._cleanup_owned_container("fullmag-openapi-remove-stuck", "remove-stuck", IMAGE)
        self.assertFalse(result.confirmed)
        self.assertTrue(result.failed)

    def test_cleanup_refuses_replacement_container_before_removal(self) -> None:
        identifier = "6" * 64
        replacement = "7" * 64
        owned = {
            "Id": identifier, "Image": IMAGE, "Name": "/fullmag-openapi-replaced",
            "State": {"Running": True},
            "Config": {"Labels": {"com.fullmag.fullmag-openapi-export": "replaced"}},
        }
        replacement_owned = {**owned, "Id": replacement, "State": {"Running": False}}
        responses = [
            subprocess.CompletedProcess([], 0, identifier + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([owned]), ""),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, replacement + "\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps([replacement_owned]), ""),
        ]
        with patch.object(exporter, "_docker_control", side_effect=responses) as control:
            result = exporter._cleanup_owned_container("fullmag-openapi-replaced", "replaced", IMAGE)
        self.assertFalse(result.confirmed)
        self.assertTrue(result.failed)
        self.assertIn("identity changed", result.detail or "")
        self.assertIn("--no-trunc", control.call_args_list[0].args[0])
        self.assertFalse(any(call.args[0][0] == "rm" for call in control.call_args_list))


class ExportStorageShellTests(unittest.TestCase):
    def _run(self, job_id: str, commit: str, suffix: str = ""):
        bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
        if not bash.is_file():
            self.skipTest("Bash unavailable")
        root = Path(__file__).resolve().parents[1]
        recipe = (f'python "{root.as_posix()}/scripts/export_runner_openapi.py" '
                  f'--repo-root "{root.as_posix()}" --job-id "{job_id}" '
                  f'--expected-commit "{commit}"{suffix}')
        return subprocess.run([str(bash), "scripts/just_storage_shell.sh", recipe],
                              cwd=root, capture_output=True, text=True, timeout=20)

    def test_shell_rejects_invalid_job_before_storage_preparation(self):
        result = self._run("invalid", COMMIT)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("invalid managed OpenAPI export recipe", result.stderr)
        self.assertNotIn("inventoried migration", result.stderr)

    def test_shell_rejects_invalid_commit_before_storage_preparation(self):
        result = self._run(JOB_ID, "HEAD")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("invalid managed OpenAPI export recipe", result.stderr)

    def test_shell_rejects_composite_recipe_without_executing_it(self):
        result = self._run(JOB_ID, COMMIT, " && printf UNAUTHORIZED_EXPORT_COMMAND")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("invalid managed OpenAPI export recipe", result.stderr)
        self.assertNotIn("UNAUTHORIZED_EXPORT_COMMAND", result.stdout)

    def test_shell_diagnostic_marker_cannot_bypass_export_argument_shape(self):
        result = self._run(JOB_ID, COMMIT, " # fullmag_storage.py resolve")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("invalid managed OpenAPI export recipe", result.stderr)


if __name__ == "__main__":
    unittest.main()
