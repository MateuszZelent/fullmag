"""Fixture regressions for the private accepted-run reattach producer."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import docker_volume_accepted_reattach as producer


def _raw(value: dict[str, object]) -> bytes:
    return producer.canonical(value) + b"\n"


class _ControlFixture:
    project = "fullmag-test"
    volume = "fullmag_control"

    def __init__(self, records: dict[str, bytes]):
        self.records = records
        self.published: tuple[str, bytes, str, bytes, str, bytes, str, bytes] | None = None

    def read_raw(self, relative: str, *, optional: bool = False) -> bytes | None:
        try:
            return self.records[relative]
        except KeyError:
            if optional:
                return None
            raise FileNotFoundError(relative)

    def publish_raw(
        self,
        proof_relative: str,
        proof_raw: bytes,
        request_relative: str,
        request_raw: bytes,
        terminal_process_relative: str,
        terminal_process_raw: bytes,
        terminal_owner_relative: str,
        terminal_owner_raw: bytes,
    ) -> None:
        self.published = (
            proof_relative,
            proof_raw,
            request_relative,
            request_raw,
            terminal_process_relative,
            terminal_process_raw,
            terminal_owner_relative,
            terminal_owner_raw,
        )


class AcceptedReattachProducerTests(unittest.TestCase):
    activation_attempt = "a" * 32
    reconciliation_attempt = "b" * 32
    development_attempt = "c" * 32
    backend = "d" * 64
    image = "sha256:" + "e" * 64
    config_sha256 = "f" * 64
    source_sha256 = "1" * 64
    provenance_sha256 = "2" * 64
    helper_sha256 = "3" * 64
    helper_absence_sha256 = "4" * 64
    source_root = "/workspace/source"
    source_relative = "examples/accepted.py"
    request_id = "startup-request"
    run_id = "run-held"
    project_id = "project-held"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Path(self.temp.name) / "session-store"
        run = self.store / "runs" / self.run_id
        run.mkdir(parents=True)
        (self.store / "WRITER.lock").write_bytes(b"lock")
        self.control = _ControlFixture({})
        self.records = self._control_records()
        self.control.records = self.records
        self._write_run(run, self.run_id)

    def _control_records(self) -> dict[str, bytes]:
        activation_key = hashlib.sha256(self.request_id.encode()).hexdigest()
        provenance = {
            "schema": "fullmag.docker-startup-script.v1",
            "authorization": "explicit_startup_script",
            "source_root": self.source_root,
            "source_relative": self.source_relative,
            "source_sha256": self.source_sha256,
            "request_id": self.request_id,
        }
        provenance_raw = (json.dumps(provenance, indent=2, ensure_ascii=False) + "\n").encode()
        authorization_raw = _raw(provenance)
        self.provenance_sha256 = hashlib.sha256(provenance_raw).hexdigest()
        inputs = {
            "development_attempt": self.development_attempt,
            "config_sha256": self.config_sha256,
            "source_root": self.source_root,
            "image_id": self.image,
            "source_relative": self.source_relative,
            "source_sha256": self.source_sha256,
            "request_id": self.request_id,
            "provenance_sha256": self.provenance_sha256,
            "backend_container": self.backend,
            "activation_receipt_key": activation_key,
            "activation_receipt_path": (
                "/opt/fullmag/control/backend/script-activation-"
                + activation_key
                + "/activation.json"
            ),
        }
        activation = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "activation",
            "state": "outcome-unknown-resources-retained",
            "attempt": self.activation_attempt,
            "compose_project": self.control.project,
            "control_volume": self.control.volume,
            "helper_container": "fullmag-control-" + self.activation_attempt,
            "helper_sha256": self.helper_sha256,
            "started_at": 1.0,
            "finished_at": 2.0,
            "error": "startup outcome was unknown",
            "inputs": inputs,
        }
        activation_raw = _raw(activation)
        failed_owner = {
            "schema_version": "runtime_service_owner.v1",
            "protocol": "stdin-v1",
            "state": "failed",
            "owner_token": "owner-token",
            "process_start_token": "process-token",
            "pid": 3241,
            "host": "fullmag-test-host",
            "target_id": "docker-all",
            "control_address": "127.0.0.1:43123",
            "build_commit": "6" * 40,
            "build_snapshot": "7" * 64,
            "compute_pool_id": "compute-pool",
            "preparation_pool_id": "preparation-pool",
            "compute_pool_generation": 7,
            "preparation_pool_generation": 8,
            "acquired_at": "2026-10-19T10:00:00Z",
            "heartbeat_at": "2026-10-19T10:00:01Z",
            "children": [
                {"role": "compute", "pid": 3250, "status": "exited_success"},
                {"role": "preparation", "pid": 3251, "status": "exited_success"},
            ],
        }
        process_receipt = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "failed_outcome_retained",
            "api_pid": 3227,
            "api_exit_code": -15,
            "error": "runtime service failed during startup",
            "runtime_pid": None,
        }
        process_receipt_sha256 = "8" * 64
        terminal = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "shutdown_unknown",
            "api_exit_code": -15,
            "runtime_pid": None,
        }
        owner_raw = (json.dumps(failed_owner, indent=2, ensure_ascii=False) + "\n").encode()
        terminal_raw = _raw(terminal)
        probe = {
            "schema": "fullmag.docker-native-start-failure-stop-probe.v1",
            "process_receipt_sha256": process_receipt_sha256,
            "process_receipt": process_receipt,
            "failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
            "failed_owner": failed_owner,
            "api_pid_exists": False,
            "owner_pid_exists": False,
            "child_pids_exist": False,
            "native_processes_live": False,
            "startup_enabled": None,
            "legacy_activation_marker_exists": False,
            "active_lease_count": 0,
            "reservation_states": ["released"],
            "lease_states": ["released"],
        }
        stop = {
            "schema": "fullmag.stop-failed-admission.v1",
            "state": "stopped-confirmed",
            "container_id": self.backend,
            "image_id": self.image,
            "container_state": {
                "id": self.backend,
                "image": self.image,
                "started_at": "2026-10-19T10:00:00Z",
                "finished_at": "2026-10-19T10:00:05Z",
                "exit_code": 1,
            },
            "exit_code": 1,
            "failure_kind": "native-start-failure",
            "failure_receipt": {
                "sha256": process_receipt_sha256,
                "receipt": process_receipt,
                "api_pid_exists": False,
            },
            "native_failure_probe": probe,
            "terminal_failed_owner": failed_owner,
            "terminal_failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
            "terminal_process_receipt": terminal,
        }
        stop_raw = _raw(stop)
        namespace = {
            "schema": "fullmag.docker-stopped-namespace-attestation.v1",
            "state": "stopped-confirmed",
            "compose_project": self.control.project,
            "control_volume": self.control.volume,
            "backend_container": self.backend,
            "image_id": self.image,
            "source_root": self.source_root,
            "container_state": dict(stop["container_state"]),
            "stop_journal_path": "verification/stop-failed-" + self.backend + ".json",
            "stop_journal_sha256": hashlib.sha256(stop_raw).hexdigest(),
            "terminal_process_receipt_path": "runtime-control/runtime-service/process-tree.json",
            "terminal_process_receipt_sha256": hashlib.sha256(terminal_raw).hexdigest(),
            "terminal_process_receipt": terminal,
            "terminal_failed_owner_path": "runtime-control/runtime-services/OWNER.json",
            "terminal_failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
            "terminal_failed_owner": failed_owner,
            "failure_kind": "native-start-failure",
            "native_failure_probe_sha256": hashlib.sha256(_raw(probe)).hexdigest(),
            "native_failure_probe": probe,
            "created_at": 6.0,
        }
        namespace_raw = _raw(namespace)
        unresolved = {
            "schema": "fullmag.docker-activation-unresolved.v1",
            "state": "unknown-retained",
            "phase": "activation",
            "activation_outcome": "unknown-retained",
            "reason": "backend-namespace-stopped",
            "compose_project": self.control.project,
            "control_volume": self.control.volume,
            "activation_attempt": self.activation_attempt,
            "development_attempt": self.development_attempt,
            "reconciliation_attempt": self.reconciliation_attempt,
            "backend_container": self.backend,
            "image_id": self.image,
            "config_sha256": self.config_sha256,
            "source_root": self.source_root,
            "source_relative": self.source_relative,
            "source_sha256": self.source_sha256,
            "provenance_sha256": self.provenance_sha256,
            "request_id": self.request_id,
            "activation_receipt_key": activation_key,
            "activation_receipt_path": inputs["activation_receipt_path"],
            "activation_receipt_sha256": hashlib.sha256(activation_raw).hexdigest(),
            "helper_container": "fullmag-control-" + self.activation_attempt,
            "helper_id": None,
            "helper_state": "absent-confirmed",
            "helper_sha256": self.helper_sha256,
            "helper_absence_probe_sha256": self.helper_absence_sha256,
            "native_stop_journal_sha256": hashlib.sha256(stop_raw).hexdigest(),
            "created_at": 3.0,
        }
        reconciliation = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "activation-reconciliation",
            "state": "failed-confirmed",
            "attempt": self.reconciliation_attempt,
            "compose_project": self.control.project,
            "control_volume": self.control.volume,
            "reconciled_activation_attempt": self.activation_attempt,
            "activation_receipt_sha256": unresolved["activation_receipt_sha256"],
            "helper_container": "fullmag-control-" + self.activation_attempt,
            "helper_id": None,
            "helper_state": "absent-confirmed",
            "helper_absence_probe_sha256": self.helper_absence_sha256,
            "helper_sha256": self.helper_sha256,
            "backend_container": self.backend,
            "image_id": self.image,
            "development_attempt": self.development_attempt,
            "config_sha256": self.config_sha256,
            "source_root": self.source_root,
            "native_stop_journal_sha256": unresolved["native_stop_journal_sha256"],
            "namespace_attestation_path": "verification/stopped-namespace-attestation-" + self.backend + ".json",
            "namespace_attestation_sha256": hashlib.sha256(namespace_raw).hexdigest(),
            "activation_outcome": "unknown-retained",
            "reason": "backend-namespace-stopped",
            "started_at": 4.0,
            "finished_at": 5.0,
        }
        reconciliation_raw = _raw(reconciliation)
        return {
            "activation/unresolved.json": _raw(unresolved),
            "activation/attempts/" + self.activation_attempt + "/receipt.json": activation_raw,
            "activation/attempts/" + self.activation_attempt + "/startup-provenance.json": provenance_raw,
            "activation/attempts/" + self.activation_attempt + "/authorization.json": authorization_raw,
            "activation-reconciliation/attempts/" + self.reconciliation_attempt + "/terminal.json": reconciliation_raw,
            "activation-reconciliation/current.json": reconciliation_raw,
            "verification/stop-failed-" + self.backend + ".json": stop_raw,
            "runtime-control/runtime-service/process-tree.json": terminal_raw,
            "runtime-control/runtime-services/OWNER.json": owner_raw,
            "verification/stopped-namespace-attestation-" + self.backend + ".json": namespace_raw,
        }

    def _write_run(self, run: Path, run_id: str) -> None:
        specification = {
            "schema_version": "run_spec.v2",
            "run_id": run_id,
            "snapshot": {
                "project_id": self.project_id,
                "definition_revision": 4,
                "definition_sha256": "5" * 64,
            },
            "parameters": {
                "fullmag.accepted_run_start": {
                    "schema_version": "accepted_run_start_policy.v1",
                    "mode": "manual",
                },
                "live_workspace": {
                    "api_instance_id": "api-1",
                    "session_id": "session-1",
                    "session_epoch": 7,
                    "scene_revision": 4,
                    "command_id": self.request_id,
                    "request_idempotency_key": self.request_id,
                    "startup_source_sha256": self.source_sha256,
                    "command": {
                        "kind": "startup_script",
                        "request_id": self.request_id,
                        "source_sha256": self.source_sha256,
                    },
                },
            },
        }
        intent = {
            "schema_version": "run_intent.v1",
            "run_id": run_id,
            "idempotency_key": "live-http-" + hashlib.sha256(self.request_id.encode()).hexdigest(),
            "payload_sha256": hashlib.sha256(producer.canonical(specification)).hexdigest(),
            "specification": specification,
        }
        catalog = {
            "schema_version": "run_catalog.v1",
            "run_id": run_id,
            "revision": 2,
            "tasks": [
                {
                    "task_id": "task-1",
                    "lifecycle": "accepted",
                    "readiness": {"state": "blocked", "reason": "manual start gate"},
                }
            ],
        }
        (run / "run_intent.json").write_bytes(_raw(intent))
        (run / "run_catalog.json").write_bytes(_raw(catalog))

    def build(self, *, run_id: str | None = None) -> dict[str, object]:
        return producer.build_accepted_reattach_bundle(
            self.control, store_root=self.store, run_id=run_id
        )

    def _replace_stop_journal(self, stop: dict[str, object]) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        stop_raw = _raw(stop)
        stop_sha256 = hashlib.sha256(stop_raw).hexdigest()
        self.records[stop_path] = stop_raw
        sidecar_path = "verification/stopped-namespace-attestation-" + self.backend + ".json"
        self.records.pop(sidecar_path, None)
        unresolved_path = "activation/unresolved.json"
        unresolved = json.loads(self.records[unresolved_path])
        unresolved["native_stop_journal_sha256"] = stop_sha256
        self.records[unresolved_path] = _raw(unresolved)
        for reconciliation_path in (
            "activation-reconciliation/attempts/" + self.reconciliation_attempt + "/terminal.json",
            "activation-reconciliation/current.json",
        ):
            reconciliation = json.loads(self.records[reconciliation_path])
            reconciliation["native_stop_journal_sha256"] = stop_sha256
            reconciliation.pop("namespace_attestation_path", None)
            reconciliation.pop("namespace_attestation_sha256", None)
            self.records[reconciliation_path] = _raw(reconciliation)

    def test_happy_path_publishes_only_runtime_control_records(self) -> None:
        result = producer.produce_accepted_reattach(self.control, store_root=self.store)
        self.assertEqual(result["environment"]["FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256"], result["pins"]["request_sha256"])
        self.assertEqual(result["pins"]["run_id"], self.run_id)
        self.assertIsNotNone(self.control.published)
        (
            proof_path,
            proof_raw,
            request_path,
            request_raw,
            terminal_process_path,
            terminal_process_raw,
            terminal_owner_path,
            terminal_owner_raw,
        ) = self.control.published  # type: ignore[misc]
        self.assertEqual(proof_path, "runtime-control/accepted-run-reattach/" + hashlib.sha256(self.request_id.encode()).hexdigest() + "/proof.json")
        self.assertEqual(request_path, "runtime-control/accepted-run-reattach/" + hashlib.sha256(self.request_id.encode()).hexdigest() + "/request.json")
        request = json.loads(request_raw)
        proof = json.loads(proof_raw)
        self.assertEqual(request["proof_path"], result["pins"]["proof_relative"])
        self.assertEqual(request["proof_sha256"], hashlib.sha256(proof_raw).hexdigest())
        self.assertEqual(proof["session_epoch"], 7)
        self.assertEqual(
            terminal_process_path,
            "runtime-control/accepted-run-reattach/"
            + hashlib.sha256(self.request_id.encode()).hexdigest()
            + "/terminal-process.json",
        )
        self.assertEqual(
            terminal_owner_path,
            "runtime-control/accepted-run-reattach/"
            + hashlib.sha256(self.request_id.encode()).hexdigest()
            + "/terminal-owner.json",
        )
        self.assertEqual(
            terminal_process_raw,
            self.records["runtime-control/runtime-service/process-tree.json"],
        )
        self.assertEqual(
            terminal_owner_raw,
            self.records["runtime-control/runtime-services/OWNER.json"],
        )
        self.assertEqual(
            proof["terminal_process_record_sha256"],
            hashlib.sha256(terminal_process_raw).hexdigest(),
        )
        self.assertEqual(
            proof["terminal_owner_record_sha256"],
            hashlib.sha256(terminal_owner_raw).hexdigest(),
        )
        sidecar_path = "verification/stopped-namespace-attestation-" + self.backend + ".json"
        self.assertEqual(
            proof["namespace_attestation_sha256"],
            hashlib.sha256(self.records[sidecar_path]).hexdigest(),
        )
        self.assertEqual(
            result["pins"]["namespace_attestation_sha256"],
            proof["namespace_attestation_sha256"],
        )

    def test_current_stop_journal_does_not_require_namespace_sidecar(self) -> None:
        """A complete current incarnation is authoritative without a sidecar."""

        sidecar_path = "verification/stopped-namespace-attestation-" + self.backend + ".json"
        del self.records[sidecar_path]
        for reconciliation_path in (
            "activation-reconciliation/attempts/" + self.reconciliation_attempt + "/terminal.json",
            "activation-reconciliation/current.json",
        ):
            reconciliation = json.loads(self.records[reconciliation_path])
            reconciliation.pop("namespace_attestation_path", None)
            reconciliation.pop("namespace_attestation_sha256", None)
            self.records[reconciliation_path] = _raw(reconciliation)

        result = self.build()
        proof = result["proof"]
        pins = result["pins"]
        self.assertNotIn("namespace_attestation_path", proof)
        self.assertNotIn("namespace_attestation_sha256", proof)
        self.assertNotIn("namespace_attestation_relative", pins)
        self.assertNotIn("namespace_attestation_sha256", pins)
        self.assertEqual(result["proof"]["stop_verification_sha256"], hashlib.sha256(
            self.records["verification/stop-failed-" + self.backend + ".json"]
        ).hexdigest())

    def test_current_stop_journal_still_requires_terminal_owner_identity(self) -> None:
        sidecar_path = "verification/stopped-namespace-attestation-" + self.backend + ".json"
        del self.records[sidecar_path]
        for reconciliation_path in (
            "activation-reconciliation/attempts/" + self.reconciliation_attempt + "/terminal.json",
            "activation-reconciliation/current.json",
        ):
            reconciliation = json.loads(self.records[reconciliation_path])
            reconciliation.pop("namespace_attestation_path", None)
            reconciliation.pop("namespace_attestation_sha256", None)
            self.records[reconciliation_path] = _raw(reconciliation)
        owner_path = "runtime-control/runtime-services/OWNER.json"
        owner = json.loads(self.records[owner_path])
        owner["pid"] += 1
        self.records[owner_path] = _raw(owner)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_terminal_owner_raw_digest_drift_is_rejected(self) -> None:
        owner_path = "runtime-control/runtime-services/OWNER.json"
        self.records[owner_path] += b" "
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_activation_input_drift_is_rejected(self) -> None:
        activation_path = "activation/attempts/" + self.activation_attempt + "/receipt.json"
        activation = json.loads(self.records[activation_path])
        activation["inputs"]["source_sha256"] = "6" * 64
        self.records[activation_path] = _raw(activation)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_ambiguous_matching_runs_are_rejected(self) -> None:
        second = self.store / "runs" / "run-second"
        second.mkdir()
        self._write_run(second, "run-second")
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_started_catalog_is_rejected(self) -> None:
        catalog_path = self.store / "runs" / self.run_id / "run_catalog.json"
        catalog = json.loads(catalog_path.read_bytes())
        catalog["tasks"][0]["lifecycle"] = "running"
        catalog_path.write_bytes(_raw(catalog))
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_explicit_path_escape_is_rejected(self) -> None:
        with self.assertRaises(producer.BuildControlError):
            self.build(run_id="../run-held")
        unresolved = json.loads(self.records["activation/unresolved.json"])
        unresolved["source_relative"] = "../secret.py"
        self.records["activation/unresolved.json"] = _raw(unresolved)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_mismatched_stopped_proof_is_rejected(self) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        stop = json.loads(self.records[stop_path])
        stop["image_id"] = "sha256:" + "7" * 64
        self.records[stop_path] = _raw(stop)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_stopped_proof_requires_top_level_exit_code(self) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        stop = json.loads(self.records[stop_path])
        del stop["exit_code"]
        self._replace_stop_journal(stop)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_stopped_proof_rejects_boolean_exit_code(self) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        stop = json.loads(self.records[stop_path])
        stop["exit_code"] = True
        self._replace_stop_journal(stop)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_stopped_proof_rejects_exit_code_drift(self) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        stop = json.loads(self.records[stop_path])
        stop["exit_code"] = 2
        self._replace_stop_journal(stop)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_historical_stop_journal_uses_fresh_namespace_sidecar_without_rewriting_journal(self) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        stop = json.loads(self.records[stop_path])
        del stop["container_state"]
        historical_raw = _raw(stop)
        self.records[stop_path] = historical_raw
        historical_sha256 = hashlib.sha256(historical_raw).hexdigest()
        unresolved_path = "activation/unresolved.json"
        unresolved = json.loads(self.records[unresolved_path])
        unresolved["native_stop_journal_sha256"] = historical_sha256
        self.records[unresolved_path] = _raw(unresolved)
        sidecar_path = "verification/stopped-namespace-attestation-" + self.backend + ".json"
        sidecar = json.loads(self.records[sidecar_path])
        sidecar["stop_journal_sha256"] = historical_sha256
        sidecar_raw = _raw(sidecar)
        self.records[sidecar_path] = sidecar_raw
        for reconciliation_path in (
            "activation-reconciliation/attempts/" + self.reconciliation_attempt + "/terminal.json",
            "activation-reconciliation/current.json",
        ):
            reconciliation = json.loads(self.records[reconciliation_path])
            reconciliation["native_stop_journal_sha256"] = historical_sha256
            reconciliation["namespace_attestation_sha256"] = hashlib.sha256(sidecar_raw).hexdigest()
            self.records[reconciliation_path] = _raw(reconciliation)
        result = self.build()
        self.assertEqual(result["proof"]["namespace_attestation_path"], "verification/stopped-namespace-attestation-" + self.backend + ".json")
        self.assertEqual(self.records[stop_path], historical_raw)

    def test_historical_sidecar_exit_code_must_match_journal(self) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        stop = json.loads(self.records[stop_path])
        del stop["container_state"]
        historical_raw = _raw(stop)
        self.records[stop_path] = historical_raw
        historical_sha256 = hashlib.sha256(historical_raw).hexdigest()
        unresolved_path = "activation/unresolved.json"
        unresolved = json.loads(self.records[unresolved_path])
        unresolved["native_stop_journal_sha256"] = historical_sha256
        self.records[unresolved_path] = _raw(unresolved)

        sidecar_path = "verification/stopped-namespace-attestation-" + self.backend + ".json"
        sidecar = json.loads(self.records[sidecar_path])
        sidecar["stop_journal_sha256"] = historical_sha256
        sidecar["container_state"]["exit_code"] = 2
        sidecar_raw = _raw(sidecar)
        self.records[sidecar_path] = sidecar_raw
        for reconciliation_path in (
            "activation-reconciliation/attempts/" + self.reconciliation_attempt + "/terminal.json",
            "activation-reconciliation/current.json",
        ):
            reconciliation = json.loads(self.records[reconciliation_path])
            reconciliation["native_stop_journal_sha256"] = historical_sha256
            reconciliation["namespace_attestation_sha256"] = hashlib.sha256(sidecar_raw).hexdigest()
            self.records[reconciliation_path] = _raw(reconciliation)

        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_historical_stop_journal_without_sidecar_is_rejected(self) -> None:
        stop_path = "verification/stop-failed-" + self.backend + ".json"
        del self.records["verification/stopped-namespace-attestation-" + self.backend + ".json"]
        stop = json.loads(self.records[stop_path])
        del stop["container_state"]
        self.records[stop_path] = _raw(stop)
        with self.assertRaises(producer.BuildControlError):
            self.build()

    def test_mismatched_namespace_sidecar_is_rejected(self) -> None:
        sidecar_path = "verification/stopped-namespace-attestation-" + self.backend + ".json"
        sidecar = json.loads(self.records[sidecar_path])
        sidecar["image_id"] = "sha256:" + "7" * 64
        self.records[sidecar_path] = _raw(sidecar)
        with self.assertRaises(producer.BuildControlError):
            self.build()


if __name__ == "__main__":
    unittest.main()
