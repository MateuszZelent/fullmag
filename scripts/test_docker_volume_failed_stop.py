"""Failure-only idle-stop reconciliation contracts; no native recovery is implied."""
from __future__ import annotations

import copy
import hashlib
import json
import select
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import docker_volume_failed_stop as failed_stop
import docker_volume_reconcile as reconciliation


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _raw(document: object) -> bytes:
    return reconciliation.canonical(document) + b"\n"


class MemoryControl:
    volume = "fullmag-test-control"

    @staticmethod
    def path(relative: str) -> str:
        return "/control/" + relative


class FailedStopFixture:
    def __init__(self):
        self.control = MemoryControl()
        self.attempt = "a" * 32
        self.previous_attempt = "b" * 32
        self.root = "iteration/attempts/" + self.attempt
        self.backend_started = "2026-10-29T18:00:00.000000000Z"
        self.backend_finished = "2026-10-29T18:39:27.000000000Z"
        self.frontend_finished = "2026-10-29T18:38:45.000000000Z"
        self.api_instance = "12345678-1234-4234-8234-123456789abc"
        self.session_id = "session-live-1"
        self.run_id = "run-live-1"
        self.session_epoch = self.session_id + "@1700000000000"
        self.request_scope_epoch = self.api_instance + ":17"
        self.request = {
            "schema": failed_stop.SCHEMA,
            "attempt": self.attempt,
            "compose_project": "fullmag-test",
            "source_root": "/source",
            "port": 3202,
            "config_sha256": "c" * 64,
            "unknown_receipt_sha256": "d" * 64,
            "controller_sha256": "e" * 64,
            "failed_stop_helper_sha256": _sha(Path(failed_stop.__file__).read_bytes()),
            "containers": {
                "lease": {"id": "1" * 64, "image": "sha256:" + "1" * 64,
                          "started_at": "lease-start", "fingerprint": "1" * 64},
                "backend": {"id": "2" * 64, "image": "sha256:" + "2" * 64,
                            "started_at": self.backend_started, "fingerprint": "2" * 64},
                "frontend": {"id": "3" * 64, "image": "sha256:" + "3" * 64,
                             "started_at": "frontend-start", "fingerprint": "3" * 64},
            },
            "failure": {},
        }
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "owner_token": "owner-token-1",
            "process_start_token": "proc-start-token-1",
            "pid": 3314,
            "host": "fullmag-test",
            "target_id": "docker-all",
            "protocol": "stdin-v1",
            "state": "ready",
            "acquired_at": "2026-10-29T17:00:00Z",
            "heartbeat_at": "2026-10-29T18:39:05Z",
            "compute_pool_generation": 3,
            "preparation_pool_generation": 3,
            "control_address": "127.0.0.1:8081",
            "build_commit": "f" * 40,
            "build_snapshot": "a" * 64,
            "compute_pool_id": "docker-all.compute",
            "preparation_pool_id": "docker-all.preparation",
            "children": [
                {"role": "compute", "pid": 3323, "status": "running"},
                {"role": "preparation", "pid": 3324, "status": "running"},
            ],
        }
        process_owner = {**owner, "heartbeat_at": "2026-10-29T18:39:04Z"}
        self.process = {
            "accepted_store": "/state/runs/docker-all/session-store",
            "api_pid": 3302,
            "bootstrap": {"state": "ready"},
            "qualification": "NOT VERIFIED",
            "schema": "fullmag.docker-process-tree.v1",
            "service_owner": process_owner,
            "shutdown_error": "Command '['/opt/fullmag/package/bin/fullmag-api']' timed out after 10 seconds",
            "state": "shutdown_unknown",
        }
        self.owner = owner
        self.preflight = {
            "schema": "fullmag.docker-terminal-session-drain-preflight.v1",
            "api_instance_id": self.api_instance,
            "session_id": self.session_id,
            "session_epoch": self.session_epoch,
            "request_scope_epoch": self.request_scope_epoch,
            "run": {
                "run_id": self.run_id,
                "session_id": self.session_id,
                "started_at": "1700000000000",
                "status": "completed",
            },
            "compute_queue": {
                "schema_version": "compute_queue.v1",
                "next_cursor": None,
                "items": [],
            },
            "runtime_service": {
                "schema_version": "application_service_status.v1",
                "configured": True,
                "state": "ready",
                "reason": {"code": "service_ready"},
            },
        }
        self.idle = {
            "active_session": True,
            "api_contract_version": "1.0.0",
            "status": "ok",
            "uptime_seconds": 1793299127,
        }
        self.previous = {
            "state": "succeeded",
            "attempt": self.previous_attempt,
            "compose_project": self.request["compose_project"],
            "config_sha256": self.request["config_sha256"],
            "state_root": "/retained/runtime-state",
            "backend_container": self.request["containers"]["backend"]["id"],
            "frontend_container": self.request["containers"]["frontend"]["id"],
            "backend_started_at": self.backend_started,
            # The old development receipt does not carry frontend_started_at.
        }
        self.original = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "iteration",
            "attempt": self.attempt,
            "state": "outcome-unknown-resources-retained",
            "error": "Backend termination is not confirmed graceful; restart withheld",
            "compose_project": self.request["compose_project"],
            "state_root": self.previous["state_root"],
            "inputs": {
                "attempt": self.previous_attempt,
                "source_root": self.request["source_root"],
                "config_sha256": self.request["config_sha256"],
                "image_id": self.request["containers"]["backend"]["image"],
            },
        }
        self.files = {}
        self.put_json("development/attempts/" + self.previous_attempt + "/terminal.json", self.previous)
        self.put_json(self.root + "/terminal-session-preflight.json", self.preflight)
        self.original["terminal_session_preflight_sha256"] = _sha(
            reconciliation.canonical(self.preflight)
        )
        self.put_json(self.root + "/idle-preflight.json", self.idle)
        self.put_json("runtime-control/runtime-service/process-tree.json", self.process)
        self.put_json("runtime-control/runtime-services/OWNER.json", self.owner)
        self.receipt_raw = _raw(self.original)
        self.files[self.root + "/receipt.json"] = self.receipt_raw
        self.request["unknown_receipt_sha256"] = _sha(self.receipt_raw)
        self.request["failure"] = {
            "previous_receipt_sha256": _sha(self.files[
                "development/attempts/" + self.previous_attempt + "/terminal.json"
            ]),
            "terminal_preflight_sha256": _sha(self.files[
                self.root + "/terminal-session-preflight.json"
            ]),
            "idle_preflight_sha256": _sha(self.files[self.root + "/idle-preflight.json"]),
            "process_receipt_sha256": _sha(self.files[
                "runtime-control/runtime-service/process-tree.json"
            ]),
            "native_owner_sha256": _sha(self.files[
                "runtime-control/runtime-services/OWNER.json"
            ]),
            "verified_sha256": None,
            "backend_finished_at": self.backend_finished,
            "frontend_finished_at": self.frontend_finished,
            "backend_exit_code": 1,
            "frontend_exit_code": 0,
        }
        self.actual = self.make_actual()

    def put_json(self, relative: str, document: object) -> None:
        self.files[relative] = _raw(document)

    def read_raw(self, control, relative: str, optional: bool = False):
        if relative in self.files:
            return self.files[relative]
        if optional:
            return None
        raise reconciliation.BuildControlError("fixture document is missing: " + relative)

    def make_actual(self):
        host_mounts = [
            {"Type": "volume", "Source": self.control.volume,
             "Target": "/opt/fullmag/runtime-control",
             "VolumeOptions": {"NoCopy": True, "Subpath": "runtime-control"}},
            {"Type": "volume", "Source": self.control.volume,
             "Target": "/opt/fullmag/control",
             "VolumeOptions": {"NoCopy": True}},
        ]
        mounted = [
            {"Type": "volume", "Name": self.control.volume,
             "Destination": "/opt/fullmag/runtime-control", "RW": True},
            {"Type": "volume", "Name": self.control.volume,
             "Destination": "/opt/fullmag/control", "RW": True},
        ]
        def service(name: str, finished: str, code: int):
            pin = self.request["containers"][name]
            return {
                "Id": pin["id"],
                "Image": pin["image"],
                "HostConfig": {"Mounts": copy.deepcopy(host_mounts)},
                "Mounts": copy.deepcopy(mounted),
                "State": {
                    "Status": "exited", "Running": False, "Paused": False,
                    "Restarting": False, "OOMKilled": False, "Dead": False,
                    "Pid": 0, "Error": "", "FinishedAt": finished,
                    "ExitCode": code, "StartedAt": pin["started_at"],
                },
            }
        return {
            "backend": service("backend", self.backend_finished, 1),
            "frontend": service("frontend", self.frontend_finished, 0),
        }

    def validate(self):
        with patch.object(reconciliation, "read_raw", side_effect=self.read_raw):
            return failed_stop.validate_failure(
                self.control, self.root, self.request, self.original, self.actual, None
            )


class FailurePinTests(unittest.TestCase):
    def setUp(self):
        self.fixture = FailedStopFixture()

    def test_exact_hashes_and_integer_exit_codes(self):
        failed_stop.validate_failure_pin(self.fixture.request["failure"])
        invalid = [
            ("previous_receipt_sha256", "A" * 64),
            ("terminal_preflight_sha256", None),
            ("idle_preflight_sha256", "short"),
            ("process_receipt_sha256", 7),
            ("native_owner_sha256", "g" * 64),
            ("verified_sha256", True),
            ("backend_finished_at", ""),
            ("frontend_finished_at", None),
            ("backend_exit_code", True),
            ("frontend_exit_code", 1),
        ]
        for key, value in invalid:
            with self.subTest(key=key):
                proof = dict(self.fixture.request["failure"])
                proof[key] = value
                with self.assertRaises(reconciliation.BuildControlError):
                    failed_stop.validate_failure_pin(proof)
        proof = dict(self.fixture.request["failure"])
        proof["extra"] = "not allowed"
        with self.assertRaises(reconciliation.BuildControlError):
            failed_stop.validate_failure_pin(proof)

    def test_valid_stop_is_failure_only_and_explicitly_requires_native_recovery(self):
        result = self.fixture.validate()
        self.assertTrue(result["native_recovery_required"])
        self.assertEqual(result["native_drain"], "unconfirmed")
        self.assertNotIn("terminal_service_owner", self.fixture.process)

    def test_original_operation_and_previous_development_receipt_are_bound(self):
        for key, value in (
            ("state", "succeeded"),
            ("error", "another stop error"),
            ("phase", "build"),
        ):
            with self.subTest(key=key):
                fixture = FailedStopFixture()
                fixture.original[key] = value
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()
        fixture = FailedStopFixture()
        fixture.files["development/attempts/" + fixture.previous_attempt + "/terminal.json"] = b"changed\n"
        with self.assertRaises(reconciliation.BuildControlError):
            fixture.validate()

    def test_preflights_require_completed_run_and_consistent_api_scope(self):
        changes = (
            lambda d: d["run"].update(status="failed"),
            lambda d: d.update(request_scope_epoch="other-api:17"),
            lambda d: d["compute_queue"].update(items=[{"state": "running", "run_id": "held"}]),
            lambda d: (d["compute_queue"].update(items=[{"state": "accepted", "run_id": "held"}]),
                       d.update(held_run_intent_sha256={"held": "a" * 64})),
            lambda d: d["runtime_service"].update(reason={"code": "unverified"}),
            lambda d: d["runtime_service"].update(state="unknown"),
            lambda d: d["run"].update(session_id="another-session"),
        )
        for change in changes:
            with self.subTest(change=change):
                fixture = FailedStopFixture()
                document = copy.deepcopy(fixture.preflight)
                change(document)
                fixture.preflight = document
                fixture.put_json(fixture.root + "/terminal-session-preflight.json", document)
                fixture.request["failure"]["terminal_preflight_sha256"] = _sha(
                    fixture.files[fixture.root + "/terminal-session-preflight.json"]
                )
                fixture.original["terminal_session_preflight_sha256"] = _sha(
                    reconciliation.canonical(document)
                )
                fixture.put_json(fixture.root + "/receipt.json", fixture.original)
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()

    def test_missing_terminal_or_idle_preflight_fails_closed(self):
        for relative in (
            "terminal-session-preflight.json",
            "idle-preflight.json",
        ):
            with self.subTest(relative=relative):
                fixture = FailedStopFixture()
                fixture.files.pop(fixture.root + "/" + relative)
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()

    def test_idle_preflight_must_be_healthy_and_report_the_active_session(self):
        for key, value in (("status", "degraded"), ("active_session", False),
                           ("api_contract_version", "other"), ("uptime_seconds", float("nan"))):
            with self.subTest(key=key):
                fixture = FailedStopFixture()
                idle = dict(fixture.idle)
                idle[key] = value
                fixture.put_json(fixture.root + "/idle-preflight.json", idle)
                fixture.request["failure"]["idle_preflight_sha256"] = _sha(
                    fixture.files[fixture.root + "/idle-preflight.json"]
                )
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()

    def test_required_mounts_and_subpaths_are_exact_and_readwrite(self):
        cases = (
            lambda m: m["HostConfig"]["Mounts"].pop(0),
            lambda m: m["HostConfig"]["Mounts"][0]["VolumeOptions"].update(Subpath="other"),
        )
        for index, mutate in enumerate(cases):
            with self.subTest(index=index):
                fixture = FailedStopFixture()
                mutate(fixture.actual["backend"])
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()
        fixture = FailedStopFixture()
        fixture.actual["backend"]["Mounts"][0]["RW"] = False
        with self.assertRaises(reconciliation.BuildControlError):
            fixture.validate()

    def test_container_must_be_the_pinned_stopped_incarnation_and_exit(self):
        cases = (
            ("Status", "running"), ("Running", True), ("Pid", 123),
            ("OOMKilled", True), ("Dead", True), ("Restarting", True),
            ("Error", "daemon error"), ("ExitCode", 0), ("FinishedAt", "different"),
        )
        for key, value in cases:
            with self.subTest(container="backend", key=key):
                fixture = FailedStopFixture()
                fixture.actual["backend"]["State"][key] = value
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()
        for key, value in (("ExitCode", 1), ("FinishedAt", "different"),
                           ("Running", True), ("Pid", 22)):
            with self.subTest(container="frontend", key=key):
                fixture = FailedStopFixture()
                fixture.actual["frontend"]["State"][key] = value
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()

    def test_native_owner_identity_is_preserved_except_heartbeat(self):
        fixture = FailedStopFixture()
        owner = copy.deepcopy(fixture.owner)
        owner["pid"] += 1
        fixture.put_json("runtime-control/runtime-services/OWNER.json", owner)
        fixture.request["failure"]["native_owner_sha256"] = _sha(
            fixture.files["runtime-control/runtime-services/OWNER.json"]
        )
        with self.assertRaises(reconciliation.BuildControlError):
            fixture.validate()

    def test_optional_api_failure_fence_is_path_checked_but_never_opened(self):
        fixture = FailedStopFixture()
        fixture.process["api_failure_fence"] = (
            "/opt/fullmag/runtime-control/runtime-service/api-failure-"
            + "a" * 32 + ".json"
        )
        fixture.put_json(
            "runtime-control/runtime-service/process-tree.json", fixture.process
        )
        fixture.request["failure"]["process_receipt_sha256"] = _sha(
            fixture.files["runtime-control/runtime-service/process-tree.json"]
        )
        self.assertTrue(fixture.validate()["native_recovery_required"])

        for path in (
            "/tmp/api-failure-" + "a" * 32 + ".json",
            "/opt/fullmag/runtime-control/runtime-service/api-failure-../x.json",
        ):
            with self.subTest(path=path):
                invalid = FailedStopFixture()
                invalid.process["api_failure_fence"] = path
                invalid.put_json(
                    "runtime-control/runtime-service/process-tree.json",
                    invalid.process,
                )
                invalid.request["failure"]["process_receipt_sha256"] = _sha(
                    invalid.files["runtime-control/runtime-service/process-tree.json"]
                )
                with self.assertRaises(reconciliation.BuildControlError):
                    invalid.validate()

    def test_absent_drain_and_recovery_checkpoints_are_required(self):
        for name in (
            "backend-drain.json", "saved-authoring-checkpoint.json",
            "saved-authoring-preflight.json", "saved-authoring-final-preflight.json",
            "diagnostic-terminal-preflight.json", "diagnostic-terminal-process-before.json",
            "idle-stop-containers.json", "backend-build-receipt.json", "provenance.json",
            "before.json", "request.json", "native-capabilities.json",
            "storage-gate-timeout-log.json", "after.json",
        ):
            with self.subTest(name=name):
                fixture = FailedStopFixture()
                fixture.files[fixture.root + "/" + name] = b"unexpected\n"
                with self.assertRaises(reconciliation.BuildControlError):
                    fixture.validate()

    def test_verified_receipt_can_be_present_or_absent_but_never_drift(self):
        fixture = FailedStopFixture()
        raw = b'{"schema":"verified"}\n'
        fixture.files["iteration/verified.json"] = raw
        fixture.request["failure"]["verified_sha256"] = _sha(raw)
        self.assertTrue(fixture.validate()["native_recovery_required"])
        fixture.files["iteration/verified.json"] = b"changed\n"
        with self.assertRaises(reconciliation.BuildControlError):
            fixture.validate()
        fixture = FailedStopFixture()
        fixture.files["iteration/verified.json"] = b"unexpected\n"
        with self.assertRaises(reconciliation.BuildControlError):
            fixture.validate()


class CommitFenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = FailedStopFixture()

    def fences(self):
        with patch.object(reconciliation, "read_raw", side_effect=self.fixture.read_raw):
            return failed_stop.commit_fences(
                self.fixture.control, self.fixture.root, self.fixture.request
            )

    def materialize(self, directory: Path):
        files = self.fixture.files
        for relative, raw in files.items():
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        return directory

    @staticmethod
    def run_fences(script: str, directory: Path):
        translated = script.replace("/control", str(directory))
        return subprocess.run(
            ["bash", "-euo", "pipefail", "-c", translated],
            capture_output=True, timeout=10,
        )

    def test_commit_fences_bind_all_files_read_only_and_reject_drift(self):
        script = self.fences()
        expected_paths = (
            self.fixture.root + "/terminal-session-preflight.json",
            self.fixture.root + "/idle-preflight.json",
            "development/attempts/" + self.fixture.previous_attempt + "/terminal.json",
            "runtime-control/runtime-service/process-tree.json",
            "runtime-control/runtime-services/OWNER.json",
            "iteration/verified.json",
        )
        for relative in expected_paths:
            self.assertIn(self.fixture.control.path(relative), script)
        for token in ("stat -c %h", "stat -c %s", "sha256sum", "readlink -f"):
            self.assertIn(token, script)
        for forbidden in (" mv ", " rm ", " touch ", "docker ", " > ", "tee "):
            self.assertNotIn(forbidden, script)
        for relative in expected_paths:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root = self.materialize(Path(directory))
                self.assertEqual(self.run_fences(script, root).returncode, 0)
                path = root / relative
                if relative == "iteration/verified.json":
                    path.write_bytes(b"late verified")
                else:
                    path.write_bytes(path.read_bytes() + b"drift")
                self.assertNotEqual(self.run_fences(script, root).returncode, 0)

    def test_commit_fences_require_verified_absence_or_exact_present_hash(self):
        script = self.fences()
        with tempfile.TemporaryDirectory() as directory:
            root = self.materialize(Path(directory))
            self.assertEqual(self.run_fences(script, root).returncode, 0)
            verified = root / "iteration/verified.json"
            verified.write_bytes(b"late verified\n")
            self.assertNotEqual(self.run_fences(script, root).returncode, 0)
        fixture = FailedStopFixture()
        raw = b"pinned verified bytes\n"
        fixture.files["iteration/verified.json"] = raw
        fixture.request["failure"]["verified_sha256"] = _sha(raw)
        self.fixture = fixture
        with patch.object(reconciliation, "read_raw", side_effect=fixture.read_raw):
            script = failed_stop.commit_fences(fixture.control, fixture.root, fixture.request)
        with tempfile.TemporaryDirectory() as directory:
            root = self.materialize(Path(directory))
            self.assertEqual(self.run_fences(script, root).returncode, 0)
            (root / "iteration/verified.json").write_bytes(b"changed")
            self.assertNotEqual(self.run_fences(script, root).returncode, 0)

    def test_unknown_receipt_fallback_is_absence_only(self):
        self.assertIn(self.fixture.control.path(self.fixture.root + "/terminal-session-preflight.json"),
                      self.fences())
        self.fixture.files[self.fixture.root + "/unknown-receipt.json"] = b"mismatched receipt\\n"
        with patch.object(reconciliation, "read_raw", side_effect=self.fixture.read_raw):
            with self.assertRaises(reconciliation.BuildControlError):
                failed_stop.commit_fences(
                    self.fixture.control, self.fixture.root, self.fixture.request
                )
        self.fixture.files[self.fixture.root + "/unknown-receipt.json"] = self.fixture.receipt_raw
        with patch.object(reconciliation, "read_raw", side_effect=self.fixture.read_raw):
            failed_stop.commit_fences(
                self.fixture.control, self.fixture.root, self.fixture.request
            )

    def test_shell_fences_reject_symlink_and_hardlink_substitution(self):
        script = self.fences()
        relative = self.fixture.root + "/terminal-session-preflight.json"
        with tempfile.TemporaryDirectory() as directory:
            root = self.materialize(Path(directory))
            target = root / relative
            target.unlink()
            target.symlink_to(root / (self.fixture.root + "/idle-preflight.json"))
            self.assertNotEqual(self.run_fences(script, root).returncode, 0)
        with tempfile.TemporaryDirectory() as directory:
            root = self.materialize(Path(directory))
            target = root / relative
            os_link = target.with_name("hardlink-copy")
            os_link.hardlink_to(target)
            self.assertNotEqual(self.run_fences(script, root).returncode, 0)


class ClaimScriptPublicationTests(unittest.TestCase):
    def _drive_claim(self, *, tamper_preflight=False):
        fixture = FailedStopFixture()
        root = fixture.root
        with tempfile.TemporaryDirectory(prefix="failed-stop-claim-") as directory:
            control_root = Path(directory) / "control"
            verified_raw = b"previous verified publication\n"
            fixture.files["iteration/verified.json"] = verified_raw
            fixture.request["failure"]["verified_sha256"] = _sha(verified_raw)
            fixture.files[root + "/unknown-receipt.json"] = fixture.receipt_raw
            for relative, raw in fixture.files.items():
                target = control_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
            (control_root / "active").write_text(fixture.request["attempt"] + "\n")
            operation_lock = control_root / "operation.lock"
            operation_lock.touch()

            native_relatives = (
                "runtime-control/runtime-service/process-tree.json",
                "runtime-control/runtime-services/OWNER.json",
            )
            native_before = {
                relative: (control_root / relative).read_bytes()
                for relative in native_relatives
            }
            verified_before = (control_root / "iteration/verified.json").read_bytes()
            unknown_before = (control_root / (root + "/unknown-receipt.json")).read_bytes()
            publication_relatives = (
                root + "/receipt.json",
                "iteration/current.json",
                root + "/terminal.json",
            )
            publication_before = {
                relative: (
                    (control_root / relative).read_bytes()
                    if (control_root / relative).exists() else None
                )
                for relative in publication_relatives
            }
            result = _raw({
                "attempt": fixture.request["attempt"],
                "failed_stop_failure_proof": {
                    **fixture.request["failure"],
                    "native_recovery_required": True,
                    "native_drain": "unconfirmed",
                },
                "state": "failed-confirmed",
            })
            result_sha = _sha(result)
            journal = root + "/reconciliation/" + result_sha
            journal_dir = control_root / journal
            journal_dir.mkdir(parents=True)
            (journal_dir / "result.json").write_bytes(result)

            with patch.object(reconciliation, "read_raw", side_effect=fixture.read_raw):
                script = reconciliation.claim_script(
                    fixture.control, root, fixture.request,
                    fixture.request["unknown_receipt_sha256"],
                    publish_verified=False,
                )
            script = script.replace("/control", str(control_root))

            def readline(stream):
                ready, _, _ = select.select([stream], [], [], 5)
                self.assertTrue(ready, "timed out waiting for the observer protocol")
                return stream.readline()

            lease = None
            observer = None
            try:
                lease = subprocess.Popen(
                    ["flock", "-x", str(operation_lock), "bash", "-c",
                     "printf 'READY\\n'; cat >/dev/null"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                self.assertEqual(readline(lease.stdout), b"READY\n")

                observer = subprocess.Popen(
                    ["bash", "-euo", "pipefail", "-c", script],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                self.assertEqual(readline(observer.stdout), b"READY\n")
                observer.stdin.write(b"BEGIN\n")
                observer.stdin.flush()
                self.assertEqual(readline(observer.stdout), b"OBSERVING\n")
                if tamper_preflight:
                    preflight = control_root / root / "terminal-session-preflight.json"
                    preflight.write_bytes(b'{"schema":"tampered"}\n')
                observer.stdin.write(("COMMIT " + result_sha + "\n").encode("ascii"))
                observer.stdin.flush()
                observer.stdin.close()
                stdout = observer.stdout.read()
                stderr = observer.stderr.read()
                returncode = observer.wait(timeout=5)

                publication_after = {
                    relative: (
                        (control_root / relative).read_bytes()
                        if (control_root / relative).exists() else None
                    )
                    for relative in publication_relatives
                }
                native_after = {
                    relative: (control_root / relative).read_bytes()
                    for relative in native_relatives
                }
                lease_is_held = lease.poll() is None
                lock_probe = subprocess.run(
                    ["flock", "-n", str(operation_lock), "true"],
                    capture_output=True, timeout=5,
                )
                return {
                    "active": (control_root / "active").read_text(),
                    "failed_stop_result": result,
                    "native_after": native_after,
                    "native_before": native_before,
                    "observer_returncode": returncode,
                    "publication_after": publication_after,
                    "publication_before": publication_before,
                    "stderr": stderr,
                    "stdout": stdout,
                    "unknown_after": (control_root / (root + "/unknown-receipt.json")).read_bytes(),
                    "unknown_before": unknown_before,
                    "verified_after": (control_root / "iteration/verified.json").read_bytes(),
                    "verified_before": verified_before,
                    "lease_is_held": lease_is_held,
                    "operation_lock_is_held": lock_probe.returncode != 0,
                }
            finally:
                if observer is not None:
                    if observer.stdin and not observer.stdin.closed:
                        observer.stdin.close()
                    if observer.poll() is None:
                        observer.terminate()
                    try:
                        observer.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        observer.kill()
                        observer.wait(timeout=5)
                    for stream in (observer.stdout, observer.stderr):
                        if stream is not None:
                            stream.close()
                if lease is not None:
                    if lease.stdin and not lease.stdin.closed:
                        lease.stdin.close()
                    try:
                        lease.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        lease.terminate()
                        lease.wait(timeout=5)
                    for stream in (lease.stdout, lease.stderr):
                        if stream is not None:
                            stream.close()

    def test_failed_stop_commit_publishes_only_control_receipts_and_keeps_original_lease(self):
        outcome = self._drive_claim()
        self.assertEqual(outcome["observer_returncode"], 0, outcome["stderr"])
        self.assertEqual(outcome["stdout"], b"COMMITTED\n")
        result = outcome["failed_stop_result"]
        self.assertEqual(json.loads(result)["state"], "failed-confirmed")
        self.assertEqual(outcome["publication_after"], {
            "iteration/attempts/" + "a" * 32 + "/receipt.json": result,
            "iteration/current.json": result,
            "iteration/attempts/" + "a" * 32 + "/terminal.json": result,
        })
        self.assertEqual(outcome["verified_after"], outcome["verified_before"])
        self.assertEqual(outcome["unknown_after"], outcome["unknown_before"])
        self.assertEqual(outcome["native_after"], outcome["native_before"])
        self.assertEqual(outcome["active"], "a" * 32 + "\n")
        self.assertTrue(outcome["lease_is_held"])
        self.assertTrue(outcome["operation_lock_is_held"])

    def test_preflight_drift_after_begin_blocks_all_publication_and_keeps_original_lease(self):
        outcome = self._drive_claim(tamper_preflight=True)
        self.assertNotEqual(outcome["observer_returncode"], 0, outcome["stdout"])
        self.assertNotIn(b"COMMITTED\n", outcome["stdout"])
        self.assertEqual(outcome["publication_after"], outcome["publication_before"])
        self.assertEqual(outcome["verified_after"], outcome["verified_before"])
        self.assertEqual(outcome["unknown_after"], outcome["unknown_before"])
        self.assertEqual(outcome["native_after"], outcome["native_before"])
        self.assertEqual(outcome["active"], "a" * 32 + "\n")
        self.assertTrue(outcome["lease_is_held"])
        self.assertTrue(outcome["operation_lock_is_held"])


class ControllerIntegrationTests(unittest.TestCase):
    def test_closed_request_and_failure_only_commit_refuse_verified_publication(self):
        fixture = FailedStopFixture()
        reconciliation.validate_request(fixture.request)
        bad = copy.deepcopy(fixture.request)
        bad["unexpected"] = True
        with self.assertRaises(reconciliation.BuildControlError):
            reconciliation.validate_request(bad)
        bad = copy.deepcopy(fixture.request)
        bad["failed_stop_helper_sha256"] = "A" * 64
        with self.assertRaises(reconciliation.BuildControlError):
            reconciliation.validate_request(bad)

        with patch.object(reconciliation, "read_raw", side_effect=fixture.read_raw):
            script = reconciliation.commit_script(
                fixture.control, fixture.root, fixture.request,
                "reconciliation/" + "f" * 64, "9" * 64,
                fixture.request["unknown_receipt_sha256"], publish_verified=False,
            )
            write_targets = next(
                part for part in script.split(";")
                if part.strip().startswith("for p in ")
            )
            self.assertNotIn("/iteration/verified.json", write_targets)
            self.assertIn("sha256sum", script)
            with self.assertRaises(reconciliation.BuildControlError):
                reconciliation.commit_script(
                    fixture.control, fixture.root, fixture.request,
                    "reconciliation/" + "f" * 64, "9" * 64,
                    fixture.request["unknown_receipt_sha256"], publish_verified=True,
                )
            with self.assertRaises(reconciliation.BuildControlError):
                reconciliation.commit_script(
                    fixture.control, fixture.root, fixture.request,
                    "reconciliation/" + "f" * 64, "9" * 64,
                    fixture.request["unknown_receipt_sha256"],
                    phase="boris-reference", publish_verified=False,
                )


if __name__ == "__main__":
    unittest.main()
