"""Mocked proofs for the preserving accepted-run continuation."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parent))


def _module():
    spec = importlib.util.find_spec("docker_volume_failed_run_resume")
    if spec is None:
        raise AssertionError("preserving failed-run resume validator is not implemented")
    import docker_volume_failed_run_resume as resume
    return resume


RUN_ID = "run-live-" + "a" * 64
TASK_A = "task-" + "b" * 64
TASK_B = "task-" + "c" * 64
TASK_C = "task-" + "d" * 64
ATTEMPT_A = "attempt-" + "e" * 32
LEASE_A = "lease-" + "f" * 32
START_RELEASE_REQUEST_ID = "1" * 64
STORE_ID = "sha256:" + "6" * 64
ARTIFACT_ID = "accepted-terminal-completion-" + "2" * 64


def _sha(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                            ensure_ascii=False).encode()).hexdigest()


def _task(task_id: str, lifecycle: str, **changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "task_id": task_id,
        "lifecycle": lifecycle,
        "attempt_id": None,
        "resource_id": None,
        "ownership_epoch": None,
        "coordinator_watermark": None,
        "coordinator_genesis": None,
        "artifact_ids": [],
    }
    value.update(changes)
    return value


def _record(value: dict[str, object]) -> dict[str, object]:
    return {"sha256": _sha(value), "value": value}


def _accepted_run_snapshot() -> dict[str, object]:
    catalog = {
        "schema_version": "run_catalog.v1",
        "run_id": RUN_ID,
        "revision": 20,
        "tasks": [
            _task(TASK_A, "succeeded", attempt_id=ATTEMPT_A,
                  resource_id="docker-all.compute.cpu", ownership_epoch=1,
                  coordinator_watermark={"command_sequence": 4, "event_sequence": 6},
                  coordinator_genesis={"run_id": RUN_ID, "task_id": TASK_A,
                                       "attempt_id": ATTEMPT_A, "ownership_epoch": 1,
                                       "lease_token": LEASE_A},
                  artifact_ids=[ARTIFACT_ID]),
            _task(TASK_B, "accepted"),
            _task(TASK_C, "accepted"),
        ],
    }
    terminal_event = {
        "schema_version": "coordinator_journal.v1",
        "entry_id": "3" * 32,
        "run_id": RUN_ID,
        "task_id": TASK_A,
        "attempt_id": ATTEMPT_A,
        "ownership_epoch": 1,
        "lease_token": LEASE_A,
        "direction": "event",
        "sequence": 6,
        "terminal": True,
        "payload": {"message": {
            "direction": "event",
            "sequence": 6,
            "message_id": "3" * 32,
            "schema_version": "worker_protocol.v3",
            "envelope": {"claim": {"run_id": RUN_ID, "task_id": TASK_A,
                                    "attempt_id": ATTEMPT_A, "ownership_epoch": 1,
                                    "lease_token": LEASE_A},
                         "event": {"kind": "completed", "assessment": "unassessed"}},
        }},
    }
    worker_exit = {
        "schema_version": "worker_process_exit_receipt.v1",
        "receipt_id": "worker-process-exit-" + "4" * 64,
        "run_id": RUN_ID,
        "task_id": TASK_A,
        "attempt_id": ATTEMPT_A,
        "ownership_epoch": 1,
        "resource_id": "docker-all.compute.cpu",
        "lease_token": LEASE_A,
        "lease_heartbeat_sequence": 2,
        "status_success": True,
        "exit_code": 0,
        "timed_out": False,
        "stop_requested": False,
    }
    released_lease = {
        "schema_version": "resource_lease.v1",
        "run_id": RUN_ID,
        "task_id": TASK_A,
        "attempt_id": ATTEMPT_A,
        "ownership_epoch": 1,
        "resource_id": "docker-all.compute.cpu",
        "lease_token": LEASE_A,
        "state": "released",
        "heartbeat_sequence": 2,
    }
    start_release = {
        "schema_version": "accepted_run_start_release.v1",
        "run_id": RUN_ID,
        "specification_sha256": _sha({"model": "preserve-existing-run"}),
        "request_id": START_RELEASE_REQUEST_ID,
        "released_at": "2026-11-13T09:28:50Z",
    }
    specification = {"model": "preserve-existing-run"}
    records = {
        "run_intent.json": _record({"schema_version": "run_intent.v1", "run_id": RUN_ID,
                                     "request_id": START_RELEASE_REQUEST_ID,
                                     "payload_sha256": _sha(specification),
                                     "specification": specification}),
        "run_catalog.json": _record(catalog),
        "start_release.json": _record(start_release),
        "artifact_catalog.json": _record({
            "schema_version": "artifact_catalog.v1",
            "run_id": RUN_ID,
            "revision": 1,
            "updated_at": "2026-11-13T09:28:50Z",
            "entries": [{
                "artifact_id": ARTIFACT_ID, "task_id": TASK_A, "attempt_id": ATTEMPT_A,
                "ownership_epoch": 1, "content_sha256": "7" * 64,
                "object_ref": "7" * 64, "status": "published",
            }],
        }),
    }
    return {
        "schema": "fullmag.failed-run-resume-store-observation.v1",
        "run_id": RUN_ID,
        "run_directories": [RUN_ID],
        "records": records,
        "coordinator_events": [_record(terminal_event)],
        "worker_exit_receipts": [_record(worker_exit)],
        "resource_leases": [_record(released_lease)],
        "task_admissions": [{"run_id": RUN_ID, "task_id": TASK_A, "attempt_id": ATTEMPT_A}],
        "task_cancellation_intents": [],
        "host_ledger": {
            "sha256": "a" * 64,
            "store_id": STORE_ID,
            "reservations": [{
                "store_id": STORE_ID, "run_id": RUN_ID, "task_id": TASK_A,
                "attempt_id": ATTEMPT_A, "ownership_epoch": 1,
                "resource_id": "docker-all.compute.cpu", "lease_token": LEASE_A,
                "state": "released", "release_proof_sha256": "8" * 64,
                "release_proof_raw_sha256": "9" * 64,
            }],
        },
        "other_run_catalogs": [],
        "store_inventory_sha256": "7" * 64,
    }


class FailedRunResumeEvidenceTests(unittest.TestCase):
    def test_preserves_completed_task_and_only_unclaimed_accepted_tasks(self):
        resume = _module()

        proof = resume.validate_accepted_run_snapshot(
            _accepted_run_snapshot(), run_id=RUN_ID,
        )

        self.assertEqual(proof["run_id"], RUN_ID)
        self.assertEqual(proof["completed_task_ids"], [TASK_A])
        self.assertEqual(proof["resumable_task_ids"], [TASK_B, TASK_C])
        self.assertEqual(proof["start_release_request_id"], START_RELEASE_REQUEST_ID)

    def test_rejects_claimed_accepted_task_before_any_lifecycle_action(self):
        resume = _module()
        evidence = _accepted_run_snapshot()
        evidence["records"]["run_catalog.json"]["value"]["tasks"][1]["attempt_id"] = "attempt-" + "8" * 32

        with self.assertRaisesRegex(resume.ResumeError, "claimed|execution evidence"):
            resume.validate_accepted_run_snapshot(evidence, run_id=RUN_ID)

    def test_rejects_nonterminal_worker_or_resource_evidence_for_b_or_c(self):
        resume = _module()
        evidence = _accepted_run_snapshot()
        evidence["worker_exit_receipts"].append(_record({
            "schema_version": "worker_process_exit_receipt.v1",
            "run_id": RUN_ID, "task_id": TASK_B, "attempt_id": "attempt-" + "9" * 32,
            "ownership_epoch": 1, "resource_id": "docker-all.compute.cpu",
            "lease_token": "lease-" + "a" * 32, "status_success": False, "exit_code": 2,
        }))

        with self.assertRaisesRegex(resume.ResumeError, "B|C|Accepted/Queued task|unclaimed"):
            resume.validate_accepted_run_snapshot(evidence, run_id=RUN_ID)

    def test_rejects_unreleased_session_or_owned_host_reservation(self):
        resume = _module()
        evidence = _accepted_run_snapshot()
        evidence["host_ledger"]["reservations"][0]["state"] = "occupied"

        with self.assertRaisesRegex(resume.ResumeError, "ledger|reservation|released"):
            resume.validate_accepted_run_snapshot(evidence, run_id=RUN_ID)

    def test_ignores_other_groups_active_ledger_reservation_but_binds_full_ledger_hash(self):
        resume = _module()
        evidence = _accepted_run_snapshot()
        evidence["host_ledger"]["reservations"].append({
            "store_id": "sha256:" + "5" * 64,
            "state": "occupied",
        })

        proof = resume.validate_accepted_run_snapshot(evidence, run_id=RUN_ID)

        self.assertEqual(proof["host_ledger_sha256"], evidence["host_ledger"]["sha256"])
        self.assertEqual(proof["host_store_id"], STORE_ID)

    def test_rejects_active_reservation_from_another_run_in_this_store(self):
        resume = _module()
        evidence = _accepted_run_snapshot()
        evidence["host_ledger"]["reservations"].append({
            "store_id": STORE_ID, "run_id": "run-prior-" + "8" * 32,
            "task_id": "task-prior-" + "8" * 32, "state": "occupied",
            "release_proof_sha256": "8" * 64,
            "release_proof_raw_sha256": "9" * 64,
        })

        with self.assertRaisesRegex(resume.ResumeError, "reservation|released"):
            resume.validate_accepted_run_snapshot(evidence, run_id=RUN_ID)

    def test_rejects_run_intent_payload_digest_that_differs_from_its_specification(self):
        resume = _module()
        evidence = _accepted_run_snapshot()
        evidence["records"]["run_intent.json"]["value"]["payload_sha256"] = "9" * 64

        with self.assertRaisesRegex(resume.ResumeError, "RunIntent|payload|specification"):
            resume.validate_accepted_run_snapshot(evidence, run_id=RUN_ID)

    def test_rejects_an_unrelated_nonterminal_run_in_store_inventory(self):
        resume = _module()
        evidence = _accepted_run_snapshot()
        evidence["run_directories"].append("run-" + "b" * 64)
        evidence["other_run_catalogs"] = [{
            "run_id": "run-" + "b" * 64,
            "tasks": [_task("task-" + "e" * 64, "accepted")],
        }]

        with self.assertRaisesRegex(resume.ResumeError, "other run|nonterminal|inventory"):
            resume.validate_accepted_run_snapshot(evidence, run_id=RUN_ID)

    def test_stop_authority_validator_is_available_for_a_typed_diagnostic_stop(self):
        resume = _module()

        self.assertTrue(callable(getattr(resume, "validate_stop_diagnostic_authority", None)))

    def test_outer_raw_hash_and_typed_body_hash_are_distinct_bindings(self):
        resume = _module()
        typed = {
            "schema": "fullmag.docker-api-diagnostic-stop.v1",
            "state": "stopped-execution-unknown",
            "attempt": "a" * 32,
            "config_sha256": "2" * 64,
            "backend_container_id": "b" * 64,
            "backend_image_id": "sha256:" + "c" * 64,
            "backend_started_at": "2026-11-13T09:05:20Z",
            "backend_exit_code": 0,
            "frontend_container_id": "d" * 64,
            "runtime_owner_state": "failed-preserved",
            "execution_state": "unknown",
            "resource_leases": "untouched",
            "runtime_config_sha256": "3" * 64,
            "failed_owner_sha256": "4" * 64,
            "failure_process_receipt_sha256": "5" * 64,
            "terminal_process_receipt_sha256": "6" * 64,
            "api_failure_fence_sha256": "7" * 64,
            "api_instance_id": "api-instance-1",
            "api_exit_code": 0,
            "shutdown_error": "runtime service owner is not ready",
            "retained_ready_owner": {"state": "ready", "owner_token": "owner-1"},
        }
        outer = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "stop-diagnostic",
            "state": "succeeded",
            "attempt": "8" * 32,
            "compose_project": "fullmag-own-group",
            "control_volume": "fullmag-control-own-group",
            "image_id": typed["backend_image_id"],
            "inputs": {
                "attempt": typed["attempt"],
                "config_sha256": typed["config_sha256"],
                "source_root": "/repo/own",
                "backend_container_id": typed["backend_container_id"],
                "frontend_container_id": typed["frontend_container_id"],
                "backend_started_at": typed["backend_started_at"],
                "image_id": typed["backend_image_id"],
                "preview_only": False,
            },
            "diagnostic_stop_terminal_sha256": _sha(typed),
        }
        typed_raw = json.dumps(typed, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        outer_raw = json.dumps(outer, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        binding = {
            "stop_attempt": outer["attempt"],
            "stop_terminal_sha256": hashlib.sha256(outer_raw).hexdigest(),
            "development_attempt": typed["attempt"],
            "config_sha256": typed["config_sha256"],
            "source_root": outer["inputs"]["source_root"],
            "compose_project": outer["compose_project"],
            "control_volume": outer["control_volume"],
            "backend_container_id": typed["backend_container_id"],
            "backend_image_id": typed["backend_image_id"],
            "backend_started_at": typed["backend_started_at"],
            "frontend_container_id": typed["frontend_container_id"],
        }

        pin = resume.validate_stop_diagnostic_authority(outer_raw, typed_raw, binding)

        self.assertEqual(pin["stop_terminal_raw_sha256"], binding["stop_terminal_sha256"])
        self.assertEqual(pin["diagnostic_terminal_raw_sha256"], hashlib.sha256(typed_raw).hexdigest())
        self.assertEqual(pin["diagnostic_terminal_body_sha256"], _sha(typed))

    def test_rejects_using_typed_terminal_raw_hash_as_outer_stop_pin(self):
        resume = _module()
        outer_raw, typed_raw, binding = self._minimal_stop_proof(resume)
        binding["stop_terminal_sha256"] = hashlib.sha256(typed_raw).hexdigest()

        with self.assertRaisesRegex(resume.ResumeError, "outer stop terminal|stop terminal digest"):
            resume.validate_stop_diagnostic_authority(outer_raw, typed_raw, binding)

    @staticmethod
    def _minimal_stop_proof(resume):
        # Reuse the explicit fixture setup above without sharing mutable records.
        typed = {
            "schema": "fullmag.docker-api-diagnostic-stop.v1", "state": "stopped-execution-unknown",
            "attempt": "a" * 32, "config_sha256": "2" * 64,
            "backend_container_id": "b" * 64, "backend_image_id": "sha256:" + "c" * 64,
            "backend_started_at": "2026-11-13T09:05:20Z", "backend_exit_code": 0,
            "frontend_container_id": "d" * 64, "runtime_owner_state": "failed-preserved",
            "execution_state": "unknown", "resource_leases": "untouched",
            "runtime_config_sha256": "3" * 64, "failed_owner_sha256": "4" * 64,
            "failure_process_receipt_sha256": "5" * 64, "terminal_process_receipt_sha256": "6" * 64,
            "api_failure_fence_sha256": "7" * 64, "api_instance_id": "api-instance-1",
            "api_exit_code": 0, "shutdown_error": "runtime service owner is not ready",
            "retained_ready_owner": {"state": "ready", "owner_token": "owner-1"},
        }
        outer = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "stop-diagnostic",
            "state": "succeeded", "attempt": "8" * 32,
            "compose_project": "fullmag-own-group", "control_volume": "fullmag-control-own-group",
            "image_id": typed["backend_image_id"],
            "inputs": {"attempt": typed["attempt"], "config_sha256": typed["config_sha256"],
                       "source_root": "/repo/own", "backend_container_id": typed["backend_container_id"],
                       "frontend_container_id": typed["frontend_container_id"],
                       "backend_started_at": typed["backend_started_at"],
                       "image_id": typed["backend_image_id"], "preview_only": False},
            "diagnostic_stop_terminal_sha256": _sha(typed),
        }
        typed_raw = json.dumps(typed, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        outer_raw = json.dumps(outer, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        return outer_raw, typed_raw, {
            "stop_attempt": outer["attempt"], "stop_terminal_sha256": hashlib.sha256(outer_raw).hexdigest(),
            "development_attempt": typed["attempt"], "config_sha256": typed["config_sha256"],
            "source_root": outer["inputs"]["source_root"], "compose_project": outer["compose_project"],
            "control_volume": outer["control_volume"], "backend_container_id": typed["backend_container_id"],
            "backend_image_id": typed["backend_image_id"], "backend_started_at": typed["backend_started_at"],
            "frontend_container_id": typed["frontend_container_id"],
        }


if __name__ == "__main__":
    unittest.main()
