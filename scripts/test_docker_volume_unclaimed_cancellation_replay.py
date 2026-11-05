"""Read-only regressions for completed unclaimed-cancellation replay."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_dev
import docker_volume_unclaimed_cancellation as cancellation


PROJECT = "fullmag-worktree-replay"
VOLUME = "fullmag-build-control-replay"
PREVIOUS_ATTEMPT = "a" * 32
MAINTENANCE_ATTEMPT = "b" * 32
REQUEST_ID = "12345678-1234-4234-8234-123456789abc"
RUN_ID = "accepted_run_1"
TASK_ID = "task_1"
BACKEND_ID = "d" * 64
HELPER_IMAGE = "sha256:" + "f" * 64


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class _ReadOnlyControl:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.project = PROJECT
        self.volume = VOLUME
        self.namespace = ""
        self.namespace_registry_sha256 = None
        self.shared_labels: dict[str, str] = {}
        self.prepare_calls = 0
        self.write_calls = 0
        self.operation_calls = 0

    def path(self, relative: str) -> str:
        return "/control/" + relative

    def helper_args(self, script: str) -> list[str]:
        return ["mock-docker-read", script]

    def prepare(self, **_kwargs: object) -> None:
        self.prepare_calls += 1

    def write(self, *_args: object, **_kwargs: object) -> None:
        self.write_calls += 1
        raise AssertionError("read-only replay attempted a control-volume write")

    def write_bytes(self, *_args: object, **_kwargs: object) -> None:
        self.write_calls += 1
        raise AssertionError("read-only replay attempted a control-volume write")

    def operation(self, *_args: object, **_kwargs: object) -> None:
        self.operation_calls += 1
        raise AssertionError("read-only replay attempted a maintenance operation")


class CompletedReplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="fm-unclaimed-replay-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.selected = self.root / "checkout"
        self.selected.mkdir()
        self.layout = {"runtime_root": str(self.root / "runtime")}
        self.identity = {
            "project_name": PROJECT,
            "project_id": "project-id",
            "worktree_id": "worktree-id",
            "checkout_kind": "worktree",
            "network_name": PROJECT + "_default",
        }
        self.fixture = self._fixture()
        self.control = _ReadOnlyControl(self.fixture["files"])
        self.volume_record = {
            "Name": VOLUME, "Driver": "local", "Options": None, "Labels": {},
        }
        self.docker_calls: list[tuple[object, ...]] = []
        self.read_paths: list[str] = []

        self._patch(docker_dev, "_select_source", return_value=(self.selected, self.layout))
        self._patch(docker_dev, "_compose_identity", return_value=self.identity)
        self._patch(cancellation, "require_host", return_value=None)
        self._patch(cancellation, "BuildControl", return_value=self.control)
        self._patch(cancellation, "toolchain_configuration", return_value={
            "services": {"fem-gpu-toolchain": {"build": {"args": {
                "FULLMAG_CUDA_BASE_IMAGE": HELPER_IMAGE,
            }}}},
        })
        self._patch(cancellation, "docker_capture", side_effect=self._docker_capture)
        self._patch(cancellation, "bounded_capture", side_effect=self._bounded_capture)
        self._patch(cancellation, "_control_raw", side_effect=self._control_raw)
        self._patch(cancellation.storage, "validate_path", side_effect=AssertionError("replay touched user store"))
        self._patch(cancellation, "_request_inputs", side_effect=AssertionError("replay reread mutable native inputs"))
        self._patch(cancellation, "build_volume_toolchain", side_effect=AssertionError("replay built toolchain"))
        self._patch(cancellation, "build_volume_runtime_images", side_effect=AssertionError("replay built images"))

    def _patch(self, target: object, name: str, **kwargs: object) -> None:
        patcher = patch.object(target, name, **kwargs)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _docker_capture(self, *args: object, **_kwargs: object) -> types.SimpleNamespace:
        self.docker_calls.append(args)
        if args != ("volume", "inspect", VOLUME):
            raise AssertionError("unexpected Docker call during completed replay: " + repr(args))
        return types.SimpleNamespace(
            returncode=0,
            stdout=json.dumps([self.volume_record]).encode(),
        )

    def _bounded_capture(self, command: list[str], **_kwargs: object) -> types.SimpleNamespace:
        if command[:1] != ["mock-docker-read"] or "find " not in command[1]:
            raise AssertionError("unexpected helper command during completed replay")
        path = self.fixture.get("listed_receipt_path")
        return types.SimpleNamespace(
            returncode=0,
            stdout=(path.encode() + b"\n") if path else b"",
            stderr=b"",
        )

    def _control_raw(self, _control: object, relative: str, *, optional: bool = False,
                     maximum: int = cancellation.MAX_CONTROL_BYTES) -> bytes | None:
        self.read_paths.append(relative)
        raw = self.fixture["files"].get(relative)
        if raw is None:
            if optional:
                return None
            raise cancellation.BuildControlError("missing test control record: " + relative)
        if len(raw) > maximum:
            raise cancellation.BuildControlError("test control record exceeds requested bound")
        return raw

    def _fixture(self) -> dict[str, object]:
        document = {
            "name": PROJECT,
            "services": {
                "backend": {},
                "frontend": {"ports": [{
                    "host_ip": "127.0.0.1", "target": 8080,
                    "protocol": "tcp", "published": "3197",
                }]},
            },
        }
        document_raw = _canonical(document) + b"\n"
        compose_sha256 = _sha(_canonical(document))
        previous = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "succeeded",
            "attempt": PREVIOUS_ATTEMPT,
            "compose_project": PROJECT,
            "inputs": {"source_root": str(self.selected)},
        }
        previous_raw = _canonical(previous) + b"\n"

        runtime_config_raw = _canonical({
            "store_root": "/state/runs/docker-all/session-store",
            "host_execution": "linux-native-v1",
        }) + b"\n"
        owner_raw = _canonical({"schema_version": "runtime_service_owner.v1", "state": "unknown"}) + b"\n"
        catalog_raw = _canonical({"run_id": RUN_ID, "revision": 3, "tasks": []}) + b"\n"
        request = {
            "schema_version": cancellation.REQUEST_SCHEMA,
            "request_id": REQUEST_ID,
            "config_sha256": _sha(runtime_config_raw),
            "owner_sha256": _sha(owner_raw),
            "expected_owner": {"schema_version": "runtime_service_owner.v1", "state": "unknown"},
            "run_id": RUN_ID,
            "task_id": TASK_ID,
            "expected_catalog_revision": 3,
            "expected_catalog_sha256": _sha(catalog_raw),
            "expected_task": {
                "task_id": TASK_ID, "lifecycle": "accepted", "attempt_id": None,
                "resource_id": None, "resolved_input_fingerprint": None,
                "coordinator_watermark": None, "coordinator_genesis": None,
            },
            "reason": "test completed cancellation replay",
        }
        request_raw = _canonical(request) + b"\n"
        request_sha256 = _sha(request_raw)

        before = {
            "schema": "fullmag.docker-volume-unclaimed-cancellation-before.v1",
            "request_id": REQUEST_ID,
            "request_sha256": request_sha256,
            "prior_attempt": PREVIOUS_ATTEMPT,
            "prior_terminal_sha256": _sha(previous_raw),
            "prior_compose_sha256": compose_sha256,
            "prior_runtime_config_sha256": _sha(runtime_config_raw),
            "prior_owner_sha256": _sha(owner_raw),
            "prior_process_receipt_sha256": "1" * 64,
            "prior_catalog_sha256": _sha(catalog_raw),
            "backend": {"container_id": BACKEND_ID},
            "frontend": {"container_id": "2" * 64},
            "container_pins": [{"service": "backend"}, {"service": "frontend"}],
        }
        before_raw = _canonical(before) + b"\n"

        native_result = {
            "schema_version": cancellation.REQUEST_SCHEMA,
            "request_id": REQUEST_ID,
            "disposition": "cancelled",
            "run_id": RUN_ID,
            "task_id": TASK_ID,
            "catalog_revision": 4,
        }
        native_stdout_sha256 = "3" * 64
        admission = {
            "schema": "fullmag.docker-runtime-unclaimed-cancellation-admission.v1",
            "attempt": MAINTENANCE_ATTEMPT,
            "request_id": REQUEST_ID,
            "request_sha256": request_sha256,
            "backend_container_id": BACKEND_ID,
            "backend_started_at": "2026-11-05T10:11:12Z",
            "backend_build_receipt_sha256": "4" * 64,
        }
        admission_raw = _canonical(admission) + b"\n"
        admission_sha256 = _sha(admission_raw)
        result_digest = _sha(_canonical(native_result) + b"\n")
        receipt_name = (
            f"{MAINTENANCE_ATTEMPT}-{REQUEST_ID}-{request_sha256}-{result_digest}.json"
        )
        receipt_relative = cancellation.RECEIPT_ROOT + "/" + receipt_name
        receipt = {
            "schema": cancellation.MAINTENANCE_RECEIPT_SCHEMA,
            "request_id": REQUEST_ID,
            "request_sha256": request_sha256,
            "state": "cancelled",
            "native_result": native_result,
            "native_stdout_sha256": native_stdout_sha256,
            "attempt": MAINTENANCE_ATTEMPT,
            "admission_sha256": admission_sha256,
        }
        receipt_raw = _canonical(receipt) + b"\n"
        operation_result = {
            "schema": cancellation.OPERATION_SCHEMA,
            "state": "cancelled",
            "request_id": REQUEST_ID,
            "request_sha256": request_sha256,
            "native_result": native_result,
            "maintenance_receipt_sha256": _sha(receipt_raw),
            "maintenance_receipt_path": receipt_relative,
            "backend_container_id": BACKEND_ID,
            "backend_finished_at": "2026-11-05T10:12:13Z",
            "admission": admission,
            "admission_sha256": admission_sha256,
        }
        operation_result_raw = _canonical(operation_result) + b"\n"
        maintenance_operation = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "succeeded",
            "attempt": MAINTENANCE_ATTEMPT,
            "compose_project": PROJECT,
            "control_volume": VOLUME,
            "helper_container": "fullmag-control-" + MAINTENANCE_ATTEMPT,
            "inputs": {"unclaimed_cancellation": {
                "request_id": REQUEST_ID,
                "request_sha256": request_sha256,
                "request_path": cancellation._request_path(REQUEST_ID),
            }},
            "unclaimed_cancellation_preflight": before,
            "unclaimed_cancellation_admission": admission,
            "unclaimed_cancellation_result": operation_result,
        }
        maintenance_operation_raw = _canonical(maintenance_operation) + b"\n"
        attempt_root = "development/attempts/" + MAINTENANCE_ATTEMPT
        files = {
            "development/attempts/" + PREVIOUS_ATTEMPT + "/terminal.json": previous_raw,
            "development/attempts/" + PREVIOUS_ATTEMPT + "/compose.json": document_raw,
            cancellation.REQUEST_ROOT + "/" + REQUEST_ID + ".json": request_raw,
            receipt_relative: receipt_raw,
            "backend/runtime-service/unclaimed-cancellation/admissions/"
            + MAINTENANCE_ATTEMPT + ".json": admission_raw,
            attempt_root + "/unclaimed-cancellation-before.json": before_raw,
            attempt_root + "/terminal.json": maintenance_operation_raw,
            attempt_root + "/receipt.json": maintenance_operation_raw,
            attempt_root + "/unclaimed-cancellation-receipt.json": receipt_raw,
            attempt_root + "/unclaimed-cancellation-terminal.json": operation_result_raw,
            # This mutable pin may be replaced after completion; replay must not consult it.
            "runtime-control/runtime-service/docker-all.json": b'{"replacement":"already archived"}\n',
        }
        return {
            "files": files,
            "listed_receipt_path": "/control/" + receipt_relative,
            "request": request,
            "request_raw": request_raw,
            "request_sha256": request_sha256,
            "document": document,
            "compose_sha256": compose_sha256,
            "previous_raw": previous_raw,
            "before": before,
            "receipt": receipt,
            "admission": admission,
            "receipt_relative": receipt_relative,
        }

    def _args(self) -> types.SimpleNamespace:
        return types.SimpleNamespace(
            attempt=PREVIOUS_ATTEMPT,
            config_sha256=self.fixture["compose_sha256"],
            repo_root=str(self.root),
            source_root=None,
            port=3197,
            request_id=REQUEST_ID,
            run_id=RUN_ID,
            task_id=TASK_ID,
            reason="test completed cancellation replay",
        )

    def _reset(self) -> None:
        refreshed = self._fixture()
        files = self.control.files
        files.clear()
        files.update(refreshed["files"])
        refreshed["files"] = files
        self.fixture.clear()
        self.fixture.update(refreshed)
        self.control.prepare_calls = 0
        self.control.write_calls = 0
        self.control.operation_calls = 0
        self.volume_record = {"Name": VOLUME, "Driver": "local", "Options": None, "Labels": {}}
        self.docker_calls.clear()
        self.read_paths.clear()

    def _rewrite_before_and_maintenance_terminal(self, before: dict[str, object]) -> None:
        files = self.control.files
        attempt_root = "development/attempts/" + MAINTENANCE_ATTEMPT
        files[attempt_root + "/unclaimed-cancellation-before.json"] = _canonical(before) + b"\n"
        terminal_path = attempt_root + "/terminal.json"
        operation = json.loads(files[terminal_path])
        operation["unclaimed_cancellation_preflight"] = before
        terminal_raw = _canonical(operation) + b"\n"
        files[terminal_path] = terminal_raw
        files[attempt_root + "/receipt.json"] = terminal_raw

    def _assert_no_replay_mutation(self) -> None:
        self.assertEqual(self.control.prepare_calls, 0)
        self.assertEqual(self.control.write_calls, 0)
        self.assertEqual(self.control.operation_calls, 0)
        self.assertEqual(self.docker_calls, [("volume", "inspect", VOLUME)])

    def test_completed_replay_uses_historical_native_and_compose_pins_read_only(self) -> None:
        result = cancellation.cancel_unclaimed(self._args())

        self.assertTrue(result["replayed_receipt"])
        self.assertEqual(result["native_result"]["disposition"], "cancelled")
        self.assertEqual(result["request_sha256"], self.fixture["request_sha256"])
        self._assert_no_replay_mutation()
        self.assertNotIn("runtime-control/runtime-service/docker-all.json", self.read_paths)

    def _install_completed_maintenance_resume(self) -> str:
        files = self.control.files
        attempt_root = "development/attempts/" + MAINTENANCE_ATTEMPT
        before_raw = files.pop(attempt_root + "/unclaimed-cancellation-before.json")
        before = json.loads(before_raw)
        operation = json.loads(files[attempt_root + "/terminal.json"])
        failed_attempt = "c" * 32
        failed_root = "development/attempts/" + failed_attempt
        failed = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "failed-confirmed",
            "attempt": failed_attempt,
            "compose_project": PROJECT,
            "control_volume": VOLUME,
            "helper_container": "fullmag-control-" + failed_attempt,
            "error": cancellation.PRESTART_RESUME_ERROR,
            "inputs": operation["inputs"],
            "unclaimed_cancellation_preflight": before,
        }
        failed_raw = _canonical(failed) + b"\n"
        files[failed_root + "/terminal.json"] = failed_raw
        files[failed_root + "/receipt.json"] = failed_raw
        files[failed_root + "/unclaimed-cancellation-before.json"] = before_raw
        operation["unclaimed_cancellation_resume"] = {
            "failed_attempt": failed_attempt,
            "failed_terminal_sha256": _sha(failed_raw),
            "preflight_sha256": _sha(before_raw),
        }
        operation_raw = _canonical(operation) + b"\n"
        files[attempt_root + "/terminal.json"] = operation_raw
        files[attempt_root + "/receipt.json"] = operation_raw
        return failed_root

    def test_completed_maintenance_resume_uses_its_pinned_original_preflight(self) -> None:
        failed_root = self._install_completed_maintenance_resume()

        result = cancellation.cancel_unclaimed(self._args())

        self.assertTrue(result["replayed_receipt"])
        self.assertEqual(result["native_result"]["disposition"], "cancelled")
        self.assertIn(failed_root + "/unclaimed-cancellation-before.json", self.read_paths)
        self._assert_no_replay_mutation()
        self.assertNotIn("runtime-control/runtime-service/docker-all.json", self.read_paths)

    def test_completed_maintenance_resume_rejects_changed_origin(self) -> None:
        cases = (
            "failed-terminal", "failed-receipt", "preflight", "link", "foreign-attempt",
            "origin-project", "origin-inputs", "origin-preflight", "origin-started",
        )
        for case in cases:
            with self.subTest(case=case):
                self._reset()
                failed_root = self._install_completed_maintenance_resume()
                files = self.control.files
                if case in ("failed-terminal", "failed-receipt"):
                    name = "terminal.json" if case == "failed-terminal" else "receipt.json"
                    files[failed_root + "/" + name] += b" "
                elif case == "preflight":
                    files[failed_root + "/unclaimed-cancellation-before.json"] += b" "
                else:
                    root = "development/attempts/" + MAINTENANCE_ATTEMPT
                    operation = json.loads(files[root + "/terminal.json"])
                    link = operation["unclaimed_cancellation_resume"]
                    if case.startswith("origin-"):
                        failed = json.loads(files[failed_root + "/terminal.json"])
                        if case == "origin-project":
                            failed["compose_project"] = "foreign-project"
                        elif case == "origin-inputs":
                            failed["inputs"] = None
                        elif case == "origin-preflight":
                            failed["unclaimed_cancellation_preflight"] = {}
                        else:
                            failed["backend_started_at"] = "2026-11-05T10:01:00Z"
                        failed_raw = _canonical(failed) + b"\n"
                        files[failed_root + "/terminal.json"] = failed_raw
                        files[failed_root + "/receipt.json"] = failed_raw
                        link["failed_terminal_sha256"] = _sha(failed_raw)
                    else:
                        link["preflight_sha256" if case == "link" else "failed_attempt"] = (
                            "e" * 64 if case == "link" else "e" * 32
                        )
                    raw = _canonical(operation) + b"\n"
                    files[root + "/terminal.json"] = raw
                    files[root + "/receipt.json"] = raw
                with self.assertRaises(cancellation.BuildControlError):
                    cancellation.cancel_unclaimed(self._args())
                self._assert_no_replay_mutation()

    def test_missing_typed_receipt_refuses_retry_without_preparing_control_volume(self) -> None:
        self.fixture["listed_receipt_path"] = None

        with self.assertRaisesRegex(cancellation.BuildControlError, "no automatic retry"):
            cancellation.cancel_unclaimed(self._args())

        self._assert_no_replay_mutation()

    def test_missing_historical_before_or_terminal_fails_closed(self) -> None:
        attempt_root = "development/attempts/" + MAINTENANCE_ATTEMPT
        for relative in (
            attempt_root + "/unclaimed-cancellation-before.json",
            attempt_root + "/terminal.json",
            attempt_root + "/unclaimed-cancellation-terminal.json",
        ):
            with self.subTest(relative=relative):
                self._reset()
                self.control.files.pop(relative)
                with self.assertRaises(cancellation.BuildControlError):
                    cancellation.cancel_unclaimed(self._args())
                self._assert_no_replay_mutation()

    def test_historical_before_pins_reject_drift(self) -> None:
        mutations = {
            "schema": "foreign.before.v1",
            "request_id": "87654321-1234-4234-8234-123456789abc",
            "request_sha256": "0" * 64,
            "prior_attempt": "c" * 32,
            "prior_terminal_sha256": "1" * 64,
            "prior_compose_sha256": "2" * 64,
            "prior_runtime_config_sha256": "3" * 64,
            "prior_owner_sha256": "4" * 64,
            "prior_catalog_sha256": "5" * 64,
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                self._reset()
                before = dict(self.fixture["before"])
                before[field] = value
                self._rewrite_before_and_maintenance_terminal(before)
                with self.assertRaises(cancellation.BuildControlError):
                    cancellation.cancel_unclaimed(self._args())
                self._assert_no_replay_mutation()

    def test_typed_receipt_admission_and_result_pins_remain_enforced(self) -> None:
        attempt_root = "development/attempts/" + MAINTENANCE_ATTEMPT
        mutations = ("receipt-result", "admission", "terminal-result")
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self._reset()
                files = self.control.files
                if mutation == "receipt-result":
                    path = self.fixture["receipt_relative"]
                    receipt = json.loads(files[path])
                    receipt["native_result"]["catalog_revision"] += 1
                    files[path] = _canonical(receipt) + b"\n"
                elif mutation == "admission":
                    path = (
                        "backend/runtime-service/unclaimed-cancellation/admissions/"
                        + MAINTENANCE_ATTEMPT + ".json"
                    )
                    admission = json.loads(files[path])
                    admission["backend_build_receipt_sha256"] = "9" * 64
                    files[path] = _canonical(admission) + b"\n"
                else:
                    path = attempt_root + "/unclaimed-cancellation-terminal.json"
                    result = json.loads(files[path])
                    result["native_result"]["catalog_revision"] += 1
                    files[path] = _canonical(result) + b"\n"

                with self.assertRaises(cancellation.BuildControlError):
                    cancellation.cancel_unclaimed(self._args())
                self._assert_no_replay_mutation()

    def test_noncanonical_historical_before_is_rejected(self) -> None:
        attempt_root = "development/attempts/" + MAINTENANCE_ATTEMPT
        before_raw = json.dumps(self.fixture["before"], indent=2).encode() + b"\n"
        self.control.files[attempt_root + "/unclaimed-cancellation-before.json"] = before_raw

        with self.assertRaisesRegex(cancellation.BuildControlError, "preflight differs"):
            cancellation.cancel_unclaimed(self._args())

        self._assert_no_replay_mutation()

    def test_before_is_loaded_from_the_attempt_pinned_by_admission(self) -> None:
        files = self.control.files
        original_root = "development/attempts/" + MAINTENANCE_ATTEMPT
        foreign_attempt = "c" * 32
        foreign_root = "development/attempts/" + foreign_attempt

        admission = dict(self.fixture["admission"])
        admission["attempt"] = foreign_attempt
        admission_raw = _canonical(admission) + b"\n"
        admission_sha256 = _sha(admission_raw)
        receipt = dict(self.fixture["receipt"])
        receipt["attempt"] = foreign_attempt
        receipt["admission_sha256"] = admission_sha256
        receipt_raw = _canonical(receipt) + b"\n"
        result_digest = _sha(_canonical(receipt["native_result"]) + b"\n")
        receipt_relative = (
            cancellation.RECEIPT_ROOT + "/" + foreign_attempt + "-" + REQUEST_ID + "-"
            + self.fixture["request_sha256"] + "-" + result_digest + ".json"
        )
        files.pop(self.fixture["receipt_relative"])
        files[receipt_relative] = receipt_raw
        files[
            "backend/runtime-service/unclaimed-cancellation/admissions/"
            + foreign_attempt + ".json"
        ] = admission_raw

        operation = json.loads(files[original_root + "/terminal.json"])
        operation["attempt"] = foreign_attempt
        operation["helper_container"] = "fullmag-control-" + foreign_attempt
        operation["unclaimed_cancellation_admission"] = admission
        terminal_result = json.loads(files[original_root + "/unclaimed-cancellation-terminal.json"])
        terminal_result.update(
            maintenance_receipt_sha256=_sha(receipt_raw),
            maintenance_receipt_path=receipt_relative,
            admission=admission,
            admission_sha256=admission_sha256,
        )
        operation["unclaimed_cancellation_result"] = terminal_result
        operation_raw = _canonical(operation) + b"\n"
        files[foreign_root + "/terminal.json"] = operation_raw
        files[foreign_root + "/receipt.json"] = operation_raw
        files[foreign_root + "/unclaimed-cancellation-receipt.json"] = receipt_raw
        files[foreign_root + "/unclaimed-cancellation-terminal.json"] = _canonical(terminal_result) + b"\n"
        # The original before remains under the old attempt and is not copied to the admission's attempt.
        self.fixture["listed_receipt_path"] = "/control/" + receipt_relative

        with self.assertRaisesRegex(cancellation.BuildControlError, "no retained preflight"):
            cancellation.cancel_unclaimed(self._args())

        self._assert_no_replay_mutation()

    def test_read_only_volume_check_keeps_name_driver_options_and_label_pins(self) -> None:
        cases = (
            ({"Name": "foreign-volume", "Driver": "local", "Options": None, "Labels": {}}, {}),
            ({"Name": VOLUME, "Driver": "nfs", "Options": None, "Labels": {}}, {}),
            ({"Name": VOLUME, "Driver": "local", "Options": {"type": "bad"}, "Labels": {}}, {}),
            ({"Name": VOLUME, "Driver": "local", "Options": None, "Labels": {}},
             {"com.fullmag.compose.project": PROJECT}),
        )
        for record, shared_labels in cases:
            with self.subTest(record=record, shared_labels=shared_labels):
                self._reset()
                self.volume_record = record
                self.control.shared_labels = shared_labels
                with self.assertRaisesRegex(cancellation.BuildControlError, "ownership/driver differs"):
                    cancellation.cancel_unclaimed(self._args())
                self.assertEqual(self.control.prepare_calls, 0)
                self.assertEqual(self.read_paths, [])
                self.assertEqual(self.docker_calls, [("volume", "inspect", VOLUME)])


if __name__ == "__main__":
    unittest.main()
