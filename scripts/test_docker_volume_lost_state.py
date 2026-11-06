"""Fail-closed evidence checks for recovery after loss of Linux session state."""
from copy import deepcopy
import hashlib
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import docker_volume_lost_state as lost
from docker_build_control import BuildControlError, canonical
from linux_native_host import CERTIFICATE_NAME, OWNER_NAME, PROFILE


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class MemoryControl:
    def __init__(self, files):
        self.project = "fullmag-master"
        self.volume = "fullmag-dev-group-ledger-v1-test"
        self.namespace = ""
        self.files = files

    def read_bytes(self, relative, **kwargs):
        return self.files[relative]


class LostLinuxStateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.state = Path(self.temporary.name)
        store = self.state / "runs/docker-all/session-store"
        store.mkdir(parents=True)
        self.writer_raw = canonical({"schema": "fullmag.writer.v1", "released": True}) + b"\n"
        (store / "WRITER.owner.json").write_bytes(self.writer_raw)

        self.development_attempt = "a" * 32
        self.stop_attempt = "b" * 32
        self.source_root = "/selected/worktree"
        self.backend_id = "c" * 64
        self.frontend_id = "d" * 64
        self.image_id = "sha256:" + "1" * 64
        self.started_at = "2026-11-06T08:00:00.000000000Z"
        self.finished_at = "2026-11-06T08:01:00.000000000Z"

        self.document = {
            "name": "fullmag-master",
            "services": {
                "backend": {
                    "environment": {"FULLMAG_SESSION_STORAGE_PROFILE": PROFILE},
                    "volumes": [
                        {"type": "bind", "source": str(self.state), "target": "/state"},
                        {"type": "volume", "source": "group-ledger", "target": "/host-ledger",
                         "volume": {"subpath": "private/ledger"}},
                    ],
                },
                "frontend": {"environment": {}, "volumes": []},
            },
            "volumes": {"group-ledger": {"name": "fullmag-dev-group-ledger-v1-test"}},
        }
        self.config_sha256 = digest(canonical(self.document))
        self.previous = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "attempt": self.development_attempt,
            "config_sha256": self.config_sha256,
            "state_root": str(self.state),
            "inputs": {"source_root": self.source_root},
        }
        self.actual = {
            "backend": {
                "Id": self.backend_id,
                "Image": self.image_id,
                "State": {
                    "Status": "exited",
                    "Pid": 0,
                    "ExitCode": 255,
                    "Running": False,
                    "Paused": False,
                    "Restarting": False,
                    "Dead": False,
                    "OOMKilled": False,
                    "StartedAt": self.started_at,
                    "FinishedAt": self.finished_at,
                },
            },
            "frontend": {"Id": self.frontend_id},
        }

        owner_raw = canonical({"schema": "failed-owner"})
        process_raw = canonical({"schema": "terminal-process"})
        config_raw = canonical({"schema": "runtime-config"})
        self.ready_owner = {
            "pid": 19002,
            "children": [{"pid": 19012}, {"pid": 19011}],
        }
        stop_terminal = {
            "schema": "fullmag.docker-api-diagnostic-stop.v1",
            "state": "stopped-execution-unknown",
            "attempt": self.development_attempt,
            "config_sha256": self.config_sha256,
            "backend_container_id": self.backend_id,
            "frontend_container_id": self.frontend_id,
            "backend_image_id": self.image_id,
            "backend_started_at": self.started_at,
            "backend_finished_at": self.finished_at,
            "backend_exit_code": self.actual["backend"]["State"]["ExitCode"],
            "runtime_owner_state": "failed-preserved",
            "execution_state": "unknown",
            "resource_leases": "untouched",
            "failed_owner_sha256": digest(owner_raw),
            "terminal_process_receipt_sha256": digest(process_raw),
            "runtime_config_sha256": digest(config_raw),
            "retained_ready_owner": self.ready_owner,
        }
        preflight = {
            "schema": "fullmag.docker-api-diagnostic-stop-preflight.v1",
            "attempt": self.development_attempt,
            "config_sha256": self.config_sha256,
            "backend_container_id": self.backend_id,
            "frontend_container_id": self.frontend_id,
            "backend_started_at": self.started_at,
            "retained_ready_owner": self.ready_owner,
            "owner_pids_absent": [19002, 19011, 19012],
        }
        previous_terminal_sha256 = digest(canonical(self.previous) + b"\n")
        receipt = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "stop-diagnostic",
            "state": "succeeded",
            "attempt": self.stop_attempt,
            "compose_project": "fullmag-master",
            "control_volume": "fullmag-dev-group-ledger-v1-test",
            "image_id": self.image_id,
            "stopped_backend": True,
            "diagnostic_stop_terminal_sha256": digest(canonical(stop_terminal)),
            "inputs": {
                "attempt": self.development_attempt,
                "source_root": self.source_root,
                "terminal_sha256": previous_terminal_sha256,
                "config_sha256": self.config_sha256,
                "image_id": self.image_id,
                "backend_container_id": self.backend_id,
                "frontend_container_id": self.frontend_id,
                "backend_started_at": self.started_at,
                "preview_only": False,
            },
        }
        receipt_raw = canonical(receipt)
        self.stop_pin = self.stop_attempt + "@" + digest(receipt_raw)

        self.ledger_raw = canonical({
            "schema_version": "host_resource_ledger.v4",
            "reservations": [],
        })
        self.control = MemoryControl({
            "stop-diagnostic/attempts/" + self.stop_attempt + "/terminal.json": receipt_raw,
            "stop-diagnostic/attempts/" + self.stop_attempt + "/receipt.json": receipt_raw,
            "stop-diagnostic/attempts/" + self.stop_attempt + "/diagnostic-stop-terminal.json":
                canonical(stop_terminal),
            "stop-diagnostic/attempts/" + self.stop_attempt + "/diagnostic-stop-preflight.json":
                canonical(preflight),
            "runtime-control/runtime-services/OWNER.json": owner_raw,
            "runtime-control/runtime-service/process-tree.json": process_raw,
            "runtime-control/runtime-service/docker-all.json": config_raw,
            "private/ledger/ledger/HOST_RESOURCE_LEDGER.json": self.ledger_raw,
        })

    def tearDown(self):
        self.temporary.cleanup()

    def validate(self, *, stop_pin=None, previous=None, document=None, actual=None, state=None):
        return lost.validate_lost_linux_state(
            self.control,
            self.stop_pin if stop_pin is None else stop_pin,
            self.previous if previous is None else previous,
            self.document if document is None else document,
            self.actual if actual is None else actual,
            self.state if state is None else state,
        )

    def test_exact_diagnostic_stop_and_empty_released_state_are_accepted(self):
        evidence = self.validate()
        self.assertEqual(evidence["stop_pin"], self.stop_pin)
        self.assertEqual(evidence["ledger_sha256"], digest(self.ledger_raw))
        self.assertEqual(evidence["released_writer_sha256"], digest(self.writer_raw))
        self.assertEqual(len(evidence["directories"]), 4)

    def test_wrong_diagnostic_terminal_digest_is_rejected(self):
        wrong_pin = self.stop_attempt + "@" + "0" * 64
        with self.assertRaises(BuildControlError):
            self.validate(stop_pin=wrong_pin)

    def test_backend_identity_or_running_state_mismatch_is_rejected(self):
        changed_identity = deepcopy(self.actual)
        changed_identity["backend"]["Id"] = "e" * 64
        with self.subTest(reason="backend identity"):
            with self.assertRaises(BuildControlError):
                self.validate(actual=changed_identity)

        changed_state = deepcopy(self.actual)
        changed_state["backend"]["State"].update(Status="running", Pid=1234, Running=True)
        with self.subTest(reason="backend state"):
            with self.assertRaises(BuildControlError):
                self.validate(actual=changed_state)

    def test_present_native_certificate_or_owner_marker_is_rejected(self):
        for name in (CERTIFICATE_NAME, OWNER_NAME):
            with self.subTest(name=name):
                marker = self.state / name
                marker.write_bytes(b"present")
                with self.assertRaises(BuildControlError):
                    self.validate()
                marker.unlink()

        dangling = self.state / CERTIFICATE_NAME
        dangling.symlink_to(self.state / "missing-certificate-target")
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_nonempty_session_store_is_rejected(self):
        store = self.state / "runs/docker-all/session-store"
        (store / "unexpected-run").mkdir()
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_unreleased_session_writer_is_rejected(self):
        writer = self.state / "runs/docker-all/session-store/WRITER.owner.json"
        writer.write_bytes(canonical({"schema": "fullmag.writer.v1", "released": False}) + b"\n")
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_active_or_unknown_ledger_reservation_is_rejected(self):
        self.control.files["private/ledger/ledger/HOST_RESOURCE_LEDGER.json"] = canonical({
            "schema_version": "host_resource_ledger.v4",
            "reservations": [{"state": "active"}],
        })
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_lost_state_consumer_inventory_rejects_foreign_container_or_volume_user(self):
        ids = {"backend": self.backend_id, "frontend": self.frontend_id}
        owned = set(ids.values())
        with patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value=owned), \
                patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value=owned):
            lost.assert_lost_state_consumers(self.control, ids)

        cases = (
            ("foreign container", owned | {"e" * 64}, owned),
            ("foreign volume consumer", owned, owned | {"f" * 64}),
        )
        for reason, containers, consumers in cases:
            with self.subTest(reason=reason):
                with patch("docker_volume_unclaimed_cancellation._project_container_ids",
                           return_value=containers), \
                        patch("docker_volume_unclaimed_cancellation._volume_consumer_ids",
                              return_value=consumers), \
                        self.assertRaises(BuildControlError):
                    lost.assert_lost_state_consumers(self.control, ids)


if __name__ == "__main__":
    unittest.main()
