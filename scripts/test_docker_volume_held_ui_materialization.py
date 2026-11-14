"""Pure held UI materialization request contracts; no Docker or volume access."""
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_volume_held_ui_materialization as subject
import docker_volume_dev as volume_dev
from docker_build_control import BuildControlError, DockerObservationBudgetExceeded


MAINTENANCE_ID = "d4764fbb-a48c-4275-a541-39f356285188"
OLD_API = "75c6d4d1-00a9-416d-b27e-6fda461ad85d"
RUN_ID = "run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0"
IMMUTABLE_RUN_INTENT_IDENTITY = {
    "api_instance_id": OLD_API,
    "scene_revision": 2,
    "session_epoch": 1,
    "session_id": "docker-startup-bf4b3f3f7d14628942d4b90dd459f173e013f11599c046d37ff402db5fbd2f00",
}
PUBLIC_SESSION_CREATED_AT_UNIX_MS = 1794582150656


def record(relative, digest):
    return {"path": relative, "sha256": digest}


def request():
    root = "held-ui-materialization/" + MAINTENANCE_ID
    stop_attempt = "c" * 32
    return {
        "schema": subject.REQUEST_SCHEMA,
        "plan": {
            "attempt": "a" * 32,
            "plan_sha256": "b" * 64,
            "maintenance_request_id": MAINTENANCE_ID,
        },
        "source_scope": {
            "compose_project": "fullmag-interactive-study",
            "control_volume": "fullmag-control",
            "namespace": "",
            "namespace_registry_sha256": None,
            "source_root": "/workspace/fullmag",
            "state_root_sha256": "d" * 64,
            "backend_container_id": "1" * 64,
            "backend_started_at": "2026-11-13T14:55:00.000000000Z",
            "frontend_container_id": "2" * 64,
            "frontend_started_at": "2026-11-13T14:56:00.000000000Z",
            "runtime_config_sha256": "e" * 64,
        },
        "stop_authority": {
            "stop_attempt": stop_attempt,
            "terminal": record(
                "held-ui-materialization-stop/attempts/" + stop_attempt + "/terminal.json",
                "f" * 64,
            ),
            "preflight": record(root + "/preflight.json", "1" * 64),
            "api_quiescence": record(root + "/api-quiescence.json", "2" * 64),
            "native_drain": record(root + "/native-drain.json", "3" * 64),
            "inventory": record(root + "/inventory.json", "4" * 64),
        },
        "accepted": {
            "project_id": "project-live-4100b4f4843786fb095305286d66ea1d5b3cf4f23d17abc62e384f6cf7c303e1",
            "run_id": RUN_ID,
            "session_id": IMMUTABLE_RUN_INTENT_IDENTITY["session_id"],
            "session_epoch": IMMUTABLE_RUN_INTENT_IDENTITY["session_epoch"],
            "session_created_at_unix_ms": PUBLIC_SESSION_CREATED_AT_UNIX_MS,
            "old_api_instance_id": OLD_API,
            "old_request_scope_epoch": OLD_API + ":" + str(IMMUTABLE_RUN_INTENT_IDENTITY["session_epoch"]),
            "scene_revision": IMMUTABLE_RUN_INTENT_IDENTITY["scene_revision"],
            "run_intent_sha256": "5" * 64,
            "run_intent_payload_sha256": "6" * 64,
            "definition_sha256": "7" * 64,
            "study_sha256": "8" * 64,
            "accepted_scene_sha256": "9" * 64,
            "execution_input_sha256": "a" * 64,
            "command_id": "fm-5886f18f-96bd-481b-a064-726f49b22d07",
            "command_kind": "relax",
            "client_intent_id": "study:relax:1794584570782:eddae8c0-f2ae-46fe-9f57-d676e0eba121",
            "request_id": "09126e13-8dce-4a7b-9093-350188eb660a",
            "request_sha256": "2e15919733f30bc66a0eaf316b1051236eb3997d20d3a2a45157a1d31c7621d4",
            "request_key_sha256": "b" * 64,
            "request_receipt_sha256": "c" * 64,
        },
    }


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def encoded_record(value):
    return canonical(value) + b"\n"


class DurableHeldControl:
    def __init__(self, records, source_scope):
        self.project = source_scope["compose_project"]
        self.volume = source_scope["control_volume"]
        self.namespace = source_scope["namespace"]
        self.namespace_registry_sha256 = source_scope["namespace_registry_sha256"]
        self.records = records
        self._active_operation = None

    def read_bytes(self, path, optional=False, maximum=None):
        value = self.records.get(path)
        if value is None and not optional:
            raise BuildControlError("missing durable control record")
        if value is not None and maximum is not None and len(value) > maximum:
            raise BuildControlError("durable control record exceeds its byte limit")
        return value

    def helper_args(self, script):
        return ("docker", "run", "--rm", "-i", "--entrypoint", "/bin/bash",
                "sha256:" + "9" * 64, "-euo", "pipefail", "-c", script)

    @staticmethod
    def path(relative):
        return "/control/" + relative


def production_held_stop_operation(control, attempt):
    receipt = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "held-ui-materialization-stop",
        "state": "starting",
        "attempt": attempt,
        "compose_project": control.project,
        "control_volume": control.volume,
        "helper_container": "fullmag-control-" + attempt,
        "inputs": {"maintenance_request_id": MAINTENANCE_ID, "run_id": RUN_ID},
        "started_at": 1.0,
        "log_byte_limit": 64 * 1024,
        "attempt_limit": 8,
        "build_data_qualification": "NOT VERIFIED",
        "minimum_free_bytes": 1024 * 1024,
        "filesystem_before": {"available_bytes": 1024 * 1024},
    }
    if control.namespace:
        receipt.update(control_namespace=control.namespace,
                       namespace_registry_sha256=control.namespace_registry_sha256)
    operation = {
        "receipt": receipt,
        "root": "held-ui-materialization-stop/attempts/" + attempt,
        "logger": SimpleNamespace(),
        "daemon_pending": False,
        "lease_ready": True,
        "helper_container_id": "9" * 64,
    }
    control._active_operation = operation
    return operation


def owner(state="ready", child_status="running"):
    return {
        "state": state,
        "owner_token": "1" * 32,
        "process_start_token": "2" * 16,
        "pid": 100,
        "host": "host-p22",
        "target_id": "target-dev",
        "protocol": "tcp",
        "build_commit": "3" * 40,
        "build_snapshot": "4" * 64,
        "control_address": "127.0.0.1:50051",
        "compute_pool_generation": 1,
        "preparation_pool_generation": 1,
        "compute_pool_id": "compute-pool-p22",
        "preparation_pool_id": "preparation-pool-p22",
        "children": [
            {"role": "compute", "pid": 101, "status": child_status},
            {"role": "preparation", "pid": 102, "status": child_status},
        ],
    }


def owner_identity(value):
    return {
        "owner_token": value["owner_token"],
        "process_start_token": value["process_start_token"],
        "pid": value["pid"],
        "host": value["host"],
        "target_id": value["target_id"],
        "protocol": value["protocol"],
        "build_commit": value["build_commit"],
        "build_snapshot": value["build_snapshot"],
        "control_address": value["control_address"],
        "compute_pool_generation": value["compute_pool_generation"],
        "preparation_pool_generation": value["preparation_pool_generation"],
        "compute_pool_id": value["compute_pool_id"],
        "preparation_pool_id": value["preparation_pool_id"],
        "children": [["compute", 101], ["preparation", 102]],
    }


def valid_proof_chain():
    value = request()
    accepted = value["accepted"]
    source = value["source_scope"]
    scene = {"revision": accepted["scene_revision"], "objects": []}
    accepted["accepted_scene_sha256"] = hashlib.sha256(canonical(scene)).hexdigest()
    receipt = {
        "command_id": accepted["command_id"],
        "request_id": accepted["request_id"],
        "request_sha256": accepted["request_sha256"],
        "key_sha256": accepted["request_key_sha256"],
        "command_kind": accepted["command_kind"],
        "client_intent_id": accepted["client_intent_id"],
        "requested_target": {"kind": "study"},
    }
    accepted["request_receipt_sha256"] = hashlib.sha256(canonical(receipt)).hexdigest()
    health = {"status": "ok", "active_session": True}
    status = {"session": {
        "session_id": accepted["session_id"],
        "session_epoch": accepted["session_id"] + "@" + str(accepted["session_created_at_unix_ms"]),
        "created_at": str(accepted["session_created_at_unix_ms"]),
        "request_scope_epoch": accepted["old_request_scope_epoch"],
    }, "resources": {"scene_revision": accepted["scene_revision"]}}
    run = {"run_id": accepted["run_id"], "session_id": accepted["session_id"],
           "resolved_backend": "fdm", "status": "waiting_for_compute"}
    queue = {"schema_version": "compute_queue.v1", "revision": "sha256:" + "1" * 64,
             "next_cursor": None, "items": [{"run_id": accepted["run_id"],
             "project_id": accepted["project_id"], "state": "pending_materialization", "task_id": None}]}
    ledger = {"revision": 0, "commands": [], "pending_count": 0, "accepted_count": 0,
              "dispatched_count": 0, "running_count": 0, "completed_count": 0,
              "rejected_count": 0, "failed_count": 0}
    runtime = {"configured": True, "state": "ready"}
    response_values = {"health": health, "status": status, "run": run, "scene": scene,
                       "queue": queue, "commands": ledger, "runtime": runtime}
    responses = {}
    for key, body in response_values.items():
        raw = canonical(body)
        responses[key] = {"raw_base64": __import__("base64").b64encode(raw).decode(),
                          "sha256": hashlib.sha256(raw).hexdigest()}
    snapshot = {"api_instance_id": OLD_API, **response_values}
    command = {"seq": 0, "command_id": accepted["command_id"],
               "kind": accepted["command_kind"], "client_intent_id": accepted["client_intent_id"],
               "target": {"kind": "study"}}
    detail_raw = b"{}"
    preflight = {
        "schema": subject.PREFLIGHT_SCHEMA,
        "source_scope": source,
        "api_response": {"responses": responses, "snapshot": snapshot},
        "commands": {"ledger": ledger, "command": command, "request_receipt": receipt,
                     "request_receipt_sha256": accepted["request_receipt_sha256"],
                     "detail": {"http_status": 404,
                                "raw_base64": __import__("base64").b64encode(detail_raw).decode(),
                                "sha256": hashlib.sha256(detail_raw).hexdigest()}},
        "native_config_sha256": "a" * 64,
        "accepted_store_binding": hashlib.sha256(
            b"fullmag.accepted-store-binding.v1\0/state/runs/docker-all/session-store/"
        ).hexdigest(),
        "process_sha256": "b" * 64,
        "run_intent_sha256": accepted["run_intent_sha256"],
        "execution_input_sha256": accepted["execution_input_sha256"],
        "api_pin": {"pid": 200, "start_token": "12345", "ppid": 1,
                    "argv": ["/opt/fullmag/package/bin/fullmag-api"],
                    "exe": "/opt/fullmag/package/bin/fullmag-api"},
        "ready_owner_identity": owner_identity(owner()),
        "ready_owner_sha256": hashlib.sha256(canonical(owner_identity(owner()))).hexdigest(),
    }
    side = {
        "run_id": accepted["run_id"],
        "store_id": "sha256:" + "c" * 64,
        "run_intent_sha256": accepted["run_intent_sha256"],
        "run_intent_payload_sha256": accepted["run_intent_payload_sha256"],
        "definition_sha256": accepted["definition_sha256"],
        "study_sha256": accepted["study_sha256"],
        "execution_input": {"schema_version": "fullmag.scene_execution_input.v1",
                            "sha256": accepted["execution_input_sha256"]},
        "run_files": [{"name": "live_demand.v1.json", "sha256": "d" * 64},
                      {"name": "run_intent.json", "sha256": accepted["run_intent_sha256"]}],
        "run_catalog_absent": True,
        "start_release_absent": True,
        "pending_materialization": True,
        "task_attempts": [], "leases": [], "workers": [], "outputs": [], "other_active_runs": [],
    }
    inventory = {"schema": subject.INVENTORY_SCHEMA, "before": side, "after": copy.deepcopy(side)}
    plan, plan_sha256 = subject.build_preview_plan(
        attempt=value["plan"]["attempt"],
        maintenance_request_id=value["plan"]["maintenance_request_id"],
        source_scope=source, accepted=accepted, preflight=preflight, inventory=inventory,
    )
    value["plan"]["plan_sha256"] = plan_sha256
    intent, intent_raw, intent_sha256 = subject.prepare_api_quiescence_intent(
        attempt=value["plan"]["attempt"],
        maintenance_request_id=value["plan"]["maintenance_request_id"],
        plan_sha256=plan_sha256, source_scope=source,
        accepted=accepted, preflight=preflight, inventory=inventory,
    )
    ready_owner = owner()
    retained_process = {"schema": "fullmag.docker-process-tree.v1",
                        "state": "failed_outcome_retained",
                        "error": "Fullmag API exited unexpectedly (-15)",
                        "api_pid": 200, "api_exit_code": -15, "api_diagnostic_only": False,
                        "accepted_store": "/state/runs/docker-all/session-store",
                        "bootstrap": {
                            "schema": "fullmag.docker-accepted-store-bootstrap.v1",
                            "store_root": "/state/runs/docker-all/session-store",
                            "binding": preflight["accepted_store_binding"],
                        },
                        "service_owner": ready_owner}
    api_pin = copy.deepcopy(preflight["api_pin"])
    quiescence = {"schema": "fullmag.native-terminal-api-quiescence.v1",
                  "intent_sha256": intent_sha256, "api_pin": api_pin, "api_closed": True,
                  "signal": "SIGTERM", "retained_process": retained_process,
                  "retained_process_sha256": hashlib.sha256(
                      canonical(retained_process) + b"\n").hexdigest()}
    terminal_owner = owner("drained", "exited_success")
    native_drain = {**retained_process, "state": "drained",
                    "terminal_service_owner": terminal_owner}
    stop_attempt = value["stop_authority"]["stop_attempt"]
    stopped = {
        "backend": {"id": source["backend_container_id"], "image_id": "sha256:" + "5" * 64,
                    "started_at": source["backend_started_at"], "running": False},
        "frontend": {"id": source["frontend_container_id"], "image_id": "sha256:" + "6" * 64,
                     "started_at": source["frontend_started_at"], "running": False},
    }
    stop_attempt = value["stop_authority"]["stop_attempt"]
    claim_path = "held-ui-materialization/" + MAINTENANCE_ID + "/api-quiescence-start.json"
    claim = {
        "schema": "fullmag.held-ui-materialization-api-quiescence-start.v1",
        "state": "started", "maintenance_request_id": MAINTENANCE_ID,
        "plan_sha256": plan_sha256, "intent_sha256": intent_sha256,
        "run_id": accepted["run_id"], "run_intent_sha256": accepted["run_intent_sha256"],
        "backend_container_id": source["backend_container_id"],
        "operation_attempt": stop_attempt,
    }
    proof_map = {"preflight": preflight, "api_quiescence": quiescence,
                 "native_drain": native_drain, "inventory": inventory,
                 "intent_raw": intent_raw}
    proof_refs = {
        key: {"path": value["stop_authority"][key]["path"],
              "sha256": hashlib.sha256(encoded_record(proof_map[key])).hexdigest()}
        for key in ("preflight", "api_quiescence", "native_drain", "inventory")
    }
    terminal = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "held-ui-materialization-stop", "attempt": stop_attempt,
        "state": "succeeded", "idle_backend_stopped": True,
        "compose_project": source["compose_project"], "control_volume": source["control_volume"],
        "control_namespace": source["namespace"],
        "namespace_registry_sha256": source["namespace_registry_sha256"],
        "config_sha256": source["runtime_config_sha256"],
        "api_quiescence_intent_sha256": quiescence["intent_sha256"],
        "inputs": {"attempt": value["plan"]["attempt"],
                    "source_root": source["source_root"],
                    "source_scope": source,
                    "config_sha256": source["runtime_config_sha256"],
                    "maintenance_request_id": value["plan"]["maintenance_request_id"],
                    "plan_sha256": value["plan"]["plan_sha256"], "run_id": accepted["run_id"],
                    "accepted_run_id": accepted["run_id"],
                    "capture_held_ui_materialization": True},
        "backend_container": source["backend_container_id"],
        "frontend_container": source["frontend_container_id"],
        "backend_started_at": source["backend_started_at"],
        "frontend_started_at": source["frontend_started_at"],
        "held_ui_stop_services": stopped,
        "held_ui_stop_services_sha256": hashlib.sha256(canonical(stopped) + b"\n").hexdigest(),
        "held_ui_stop_proofs": proof_refs,
        "held_ui_api_quiescence_claim": {
            "path": claim_path, "sha256": hashlib.sha256(encoded_record(claim)).hexdigest(),
            "operation_attempt": stop_attempt, "state": "consumed",
            "quiescence_receipt_sha256": hashlib.sha256(encoded_record(quiescence)).hexdigest(),
        },
    }
    proof_map["terminal"] = terminal
    proof_map["claim"] = claim
    for key, proof in proof_map.items():
        if key in {"claim", "intent_raw"}:
            continue
        path = value["stop_authority"][key]["path"]
        value["stop_authority"][key]["sha256"] = hashlib.sha256(encoded_record(proof)).hexdigest()
    return value, proof_map


def proof_records(value, proofs):
    raw = {
        value["stop_authority"][key]["path"]: encoded_record(proofs[key])
        for key in ("preflight", "api_quiescence", "native_drain", "inventory", "terminal")
    }
    claim_ref = proofs["terminal"]["held_ui_api_quiescence_claim"]
    raw[claim_ref["path"]] = encoded_record(proofs["claim"])
    raw["held-ui-materialization/" + value["plan"]["maintenance_request_id"]
        + "/api-quiescence-intent.json"] = proofs["intent_raw"]
    return raw


class RequestContracts(unittest.TestCase):
    def setUp(self):
        self.value = request()

    def test_request_binds_distinct_session_and_request_scope_epochs(self):
        validated = subject.validate_request(
            self.value, expected_maintenance_request_id=MAINTENANCE_ID,
        )
        self.assertEqual(validated, self.value)
        self.assertEqual(subject.request_relative(MAINTENANCE_ID),
                         "held-ui-materialization/" + MAINTENANCE_ID + "/request.json")
        self.assertEqual(
            int(self.value["accepted"]["old_request_scope_epoch"].rsplit(":", 1)[1]),
            self.value["accepted"]["session_epoch"],
        )
        self.assertNotEqual(self.value["accepted"]["session_epoch"],
                            self.value["accepted"]["session_created_at_unix_ms"])
        self.assertEqual(self.value["accepted"]["session_epoch"],
                         IMMUTABLE_RUN_INTENT_IDENTITY["session_epoch"])
        self.assertEqual(self.value["accepted"]["session_created_at_unix_ms"],
                         PUBLIC_SESSION_CREATED_AT_UNIX_MS)

    def test_request_rejects_unknown_fields_at_every_boundary(self):
        mutations = [
            lambda value: value.update(unexpected=True),
            lambda value: value["plan"].update(unexpected=True),
            lambda value: value["source_scope"].update(unexpected=True),
            lambda value: value["stop_authority"].update(unexpected=True),
            lambda value: value["accepted"].update(unexpected=True),
            lambda value: value["stop_authority"]["inventory"].update(unexpected=True),
        ]
        for mutate in mutations:
            value = copy.deepcopy(self.value)
            mutate(value)
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                subject.validate_request(value)

    def test_request_rejects_foreign_or_escaping_companion_paths(self):
        mutations = [
            lambda value: value["stop_authority"]["preflight"].update(
                path="../preflight.json"),
            lambda value: value["stop_authority"]["native_drain"].update(
                path="held-ui-materialization/other/native-drain.json"),
            lambda value: value["stop_authority"]["terminal"].update(
                path="verification/terminal.json"),
            lambda value: value["stop_authority"].update(stop_attempt="d" * 32),
        ]
        for mutate in mutations:
            value = copy.deepcopy(self.value)
            mutate(value)
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                subject.validate_request(value)

    def test_request_rejects_epoch_scene_hash_and_compute_receipt_drift(self):
        mutations = [
            lambda value: value["accepted"].update(session_epoch=True),
            lambda value: value["accepted"].update(session_created_at_unix_ms=True),
            lambda value: value["accepted"].update(scene_revision=True),
            lambda value: value["accepted"].update(old_request_scope_epoch="foreign:1"),
            lambda value: value["accepted"].update(old_request_scope_epoch=OLD_API + ":2"),
            lambda value: value["accepted"].update(request_sha256="x" * 64),
            lambda value: value["accepted"].update(command_kind="startup_script"),
            lambda value: value["accepted"].update(command_id="other-command"),
        ]
        for mutate in mutations:
            value = copy.deepcopy(self.value)
            mutate(value)
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                subject.validate_request(value)

    def test_request_rejects_noncanonical_scope_and_missing_native_authority(self):
        mutations = [
            lambda value: value["source_scope"].update(namespace_registry_sha256="0" * 64),
            lambda value: value["source_scope"].update(backend_container_id="not-a-container"),
            lambda value: value["stop_authority"]["api_quiescence"].update(sha256="x" * 64),
            lambda value: value["stop_authority"].pop("native_drain"),
        ]
        for mutate in mutations:
            value = copy.deepcopy(self.value)
            mutate(value)
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                subject.validate_request(value)

    def test_start_handoff_is_exact_and_disables_legacy_startup_authority(self):
        relative = subject.request_relative(MAINTENANCE_ID)
        digest = "a" * 64
        env = subject.start_environment(relative, digest)
        metadata = {"schema": subject.HANDOFF_SCHEMA, "request_path": relative,
                    "request_sha256": digest, "run_id": RUN_ID,
                    "command_id": self.value["accepted"]["command_id"]}
        self.assertEqual(subject.validate_start_handoff(env, metadata), (env, metadata))
        with self.assertRaises(BuildControlError):
            subject.validate_start_handoff({**env, "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION": "x"}, metadata)
        target = {
            "FULLMAG_STARTUP_ENABLED": "1",
            "FULLMAG_STARTUP_SCRIPT": "/run/old.py",
            "FULLMAG_STARTUP_PROVENANCE": "/run/old.json",
            "FULLMAG_STARTUP_PROVENANCE_SHA256": "b" * 64,
            "FULLMAG_STARTUP_HELPER_SHA256": "c" * 64,
            "FULLMAG_STARTUP_RECEIPT_KEY": "d" * 64,
            "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION": "legacy",
            "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256": "e" * 64,
            "KEEP": "pinned",
        }
        subject.sanitize_backend_environment(target, enabled=True)
        self.assertEqual(target["FULLMAG_STARTUP_ENABLED"], "0")
        self.assertEqual(target["KEEP"], "pinned")
        self.assertFalse(any(name in target for name in subject.STARTUP_ENV_NAMES
                             if name != "FULLMAG_STARTUP_ENABLED"))
        self.assertFalse(any(name in target for name in subject.RECOVERY_ENV_NAMES))

    def test_ordinary_start_clears_all_held_restore_environment(self):
        target = {
            subject.REQUEST_ENV: subject.request_relative(MAINTENANCE_ID),
            subject.REQUEST_DIGEST_ENV: "a" * 64,
            subject.STDIN_ENV: "1",
            "KEEP": "pinned",
        }
        self.assertIs(subject.clear_start_environment(target), target)
        self.assertEqual(target, {"KEEP": "pinned"})


class CompletedProofContracts(unittest.TestCase):
    def setUp(self):
        self.value, self.proofs = valid_proof_chain()

    def test_completed_proof_chain_binds_scope_api_owner_intent_and_drain(self):
        raw = proof_records(self.value, self.proofs)
        result = subject.validate_stop_proofs(self.value, raw.__getitem__)
        self.assertEqual(result["terminal"]["phase"], "held-ui-materialization-stop")

    def test_preflight_scope_and_api_incarnation_cannot_drift(self):
        for mutate in (
            lambda preflight: preflight["source_scope"].update(state_root_sha256="f" * 64),
            lambda preflight: preflight["api_pin"].update(pid=201),
            lambda preflight: preflight.update(execution_input_sha256="f" * 64),
        ):
            value, proofs = valid_proof_chain()
            mutate(proofs["preflight"])
            raw = proof_records(value, proofs)
            with self.assertRaises(BuildControlError):
                subject.validate_stop_proofs(value, raw.__getitem__)

    def test_preview_requires_the_accepted_run_to_be_resolved_to_fdm(self):
        for backend in ("fem", "auto", None):
            value, proofs = valid_proof_chain()
            run = proofs["preflight"]["api_response"]["snapshot"]["run"]
            run["resolved_backend"] = backend
            raw = canonical(run)
            response = proofs["preflight"]["api_response"]["responses"]["run"]
            response["raw_base64"] = __import__("base64").b64encode(raw).decode()
            response["sha256"] = hashlib.sha256(raw).hexdigest()
            with self.subTest(backend=backend), self.assertRaises(BuildControlError):
                subject.validate_preflight(proofs["preflight"], value["accepted"])

    def test_quiescence_capture_rechecks_resolved_fdm_before_pidfd_close(self):
        script = subject.HELD_API_QUIESCE_CAPTURE_BODY
        authority = script.split("def read_held_authority(intent):", 1)[1].split(
            "request_raw=", 1,
        )[0]
        self.assertIn('current["run"].get("resolved_backend")!="fdm"', authority)
        self.assertLess(authority.index('current["run"].get("resolved_backend")!="fdm"'),
                        script.index("retained_raw,retained=pidfd_close_api("))

    def test_inventory_requires_exact_accepted_intent_and_execution_input(self):
        for field, change in (
            ("run_files", lambda side: side["run_files"][1].update(sha256="f" * 64)),
            ("execution_input", lambda side: side["execution_input"].update(sha256="f" * 64)),
        ):
            value, proofs = valid_proof_chain()
            change(proofs["inventory"]["before"])
            change(proofs["inventory"]["after"])
            raw = proof_records(value, proofs)
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                subject.validate_stop_proofs(value, raw.__getitem__)

    def test_retained_process_bootstrap_is_cross_bound_to_preflight(self):
        for label, mutate in (
            ("bootstrap binding", lambda process: process["bootstrap"].update(binding="0" * 64)),
            ("bootstrap store root", lambda process: process["bootstrap"].update(store_root="/state/other")),
            ("accepted store path", lambda process: process.update(accepted_store="/state/other")),
            ("diagnostic-only capability", lambda process: process.update(api_diagnostic_only=True)),
        ):
            value, proofs = valid_proof_chain()
            process = proofs["api_quiescence"]["retained_process"]
            mutate(process)
            proofs["api_quiescence"]["retained_process_sha256"] = hashlib.sha256(
                canonical(process) + b"\n").hexdigest()
            raw = proof_records(value, proofs)
            with self.subTest(label=label), self.assertRaises(BuildControlError):
                subject.validate_stop_proofs(value, raw.__getitem__)

    def test_terminal_must_bind_both_exact_stopped_service_incarnations(self):
        value, proofs = valid_proof_chain()
        proofs["terminal"]["held_ui_stop_services"]["frontend"]["started_at"] = "changed"
        proofs["terminal"]["held_ui_stop_services_sha256"] = hashlib.sha256(
            canonical(proofs["terminal"]["held_ui_stop_services"]) + b"\n").hexdigest()
        raw = proof_records(value, proofs)
        with self.assertRaises(BuildControlError):
            subject.validate_stop_proofs(value, raw.__getitem__)

    def test_terminal_proof_reference_cannot_drift_from_request(self):
        value, proofs = valid_proof_chain()
        proofs["terminal"]["held_ui_stop_proofs"]["inventory"]["sha256"] = "f" * 64
        value["stop_authority"]["terminal"]["sha256"] = hashlib.sha256(
            encoded_record(proofs["terminal"])).hexdigest()
        raw = proof_records(value, proofs)
        with self.assertRaisesRegex(BuildControlError, "proof references differ"):
            subject.validate_stop_proofs(value, raw.__getitem__)


class RecreateClaimContracts(unittest.TestCase):
    def test_claim_is_leased_immutable_and_request_bound(self):
        value = request()
        relative = subject.request_relative(MAINTENANCE_ID)
        request_sha256 = "a" * 64
        environment = subject.start_environment(relative, request_sha256)
        metadata = {
            "schema": subject.HANDOFF_SCHEMA,
            "request_path": relative,
            "request_sha256": request_sha256,
            "run_id": value["accepted"]["run_id"],
            "command_id": value["accepted"]["command_id"],
        }
        recreate_input = subject.recreate_input(environment, metadata, value)
        attempt = "e" * 32
        operation = {
            "root": "recreate-services/attempts/" + attempt,
            "receipt": {"phase": "recreate-services", "attempt": attempt},
        }

        class Control:
            _active_operation = operation

            def __init__(self):
                self.records = {}

            def read_bytes(self, path, optional=False):
                raw = self.records.get(path)
                if raw is None and not optional:
                    raise BuildControlError("missing control record")
                return raw

            def write_bytes(self, path, raw):
                if path in self.records:
                    raise BuildControlError("immutable record already exists")
                self.records[path] = raw

        control = Control()
        claim, digest = subject.publish_recreate_claim(control, operation, recreate_input)
        path = "runtime-control/" + subject.recreate_claim_relative(MAINTENANCE_ID)
        raw = control.read_bytes(path)
        self.assertEqual(raw, encoded_record(claim))
        self.assertEqual(digest, subject.sha(raw))
        self.assertEqual(subject.validate_recreate_claim(
            claim, request=value, request_sha256=request_sha256, expected_sha256=digest,
        ), claim)
        with self.assertRaisesRegex(BuildControlError, "already exists"):
            subject.publish_recreate_claim(control, operation, recreate_input)


class PreviewPlanContracts(unittest.TestCase):
    def test_preview_plan_ignores_health_uptime_but_binds_accepted_basis(self):
        request_value, proofs = valid_proof_chain()
        common = {
            "attempt": request_value["plan"]["attempt"],
            "maintenance_request_id": request_value["plan"]["maintenance_request_id"],
            "source_scope": request_value["source_scope"],
            "accepted": request_value["accepted"],
            "preflight": proofs["preflight"],
            "inventory": proofs["inventory"],
        }
        first, first_sha = subject.build_preview_plan(**common)
        changed_uptime = copy.deepcopy(common)
        changed_uptime["preflight"]["api_response"]["snapshot"]["health"]["uptime_seconds"] = 901
        second, second_sha = subject.build_preview_plan(**changed_uptime)
        self.assertEqual(first, second)
        self.assertEqual(first_sha, second_sha)

        changed_scene = copy.deepcopy(common)
        changed_scene["preflight"]["api_response"]["snapshot"]["status"]["resources"]["scene_revision"] += 1
        _plan, changed_sha = subject.build_preview_plan(**changed_scene)
        self.assertNotEqual(first_sha, changed_sha)

    def test_preflight_capture_uses_bounded_read_only_docker_exec(self):
        request_value, proofs = valid_proof_chain()
        captured = {"accepted": request_value["accepted"],
                    "preflight": proofs["preflight"], "inventory": proofs["inventory"]}
        result = SimpleNamespace(stdout=canonical(captured))
        with patch("docker_build_control.docker_capture", return_value=result) as docker:
            accepted, preflight, inventory = subject.capture_readonly_preflight(
                "1" * 64, attempt=request_value["plan"]["attempt"],
                maintenance_request_id=request_value["plan"]["maintenance_request_id"],
                run_id=RUN_ID, source_scope=request_value["source_scope"],
            )
        self.assertEqual(accepted, request_value["accepted"])
        self.assertEqual(preflight["api_response"]["snapshot"]["status"]["session"]["session_epoch"],
                         accepted["session_id"] + "@" + str(accepted["session_created_at_unix_ms"]))
        self.assertEqual(preflight["api_response"]["snapshot"]["status"]["session"]["created_at"],
                         str(PUBLIC_SESSION_CREATED_AT_UNIX_MS))
        self.assertEqual(accepted["session_epoch"], 1)
        self.assertEqual(accepted["session_created_at_unix_ms"], PUBLIC_SESSION_CREATED_AT_UNIX_MS)
        self.assertEqual(inventory["before"], inventory["after"])
        argv = docker.call_args.args
        self.assertEqual(argv[:3], ("exec", "-i", "1" * 64))
        self.assertEqual(argv[3:6], ("python3", "-I", "-B"))
        self.assertIn("GET", argv[7])

    def test_raw_scene_sha_is_used_by_preview_and_quiescence_stability_fences(self):
        import ast

        first_wire = b'{"revision":2,"objects":[{"bounds_max":[4e-9,2e-9,1e-9]}]}'
        second_wire = b'{"revision":2,"objects":[{"bounds_max":[4e-09,2e-09,1e-09]}]}'
        parsed_scene = json.loads(first_wire)
        self.assertEqual(parsed_scene, json.loads(second_wire))
        first_sha = hashlib.sha256(first_wire).hexdigest()
        second_sha = hashlib.sha256(second_wire).hexdigest()
        self.assertNotEqual(first_sha, second_sha)
        snapshot = {
            "api_instance_id": OLD_API,
            "status": {"session": {"session_id": "s", "session_epoch": "s@1",
                                    "created_at": "1", "request_scope_epoch": OLD_API + ":1"},
                       "resources": {"scene_revision": 2}},
            "scene": parsed_scene,
            "run": {"run_id": RUN_ID, "session_id": "s", "revision": 2,
                    "status": "waiting_for_compute", "started_at": None},
            "queue": {"revision": "q", "items": [], "next_cursor": None},
            "commands": {"revision": 1, "commands": [], "pending_count": 0,
                         "accepted_count": 0, "dispatched_count": 0, "running_count": 0,
                         "completed_count": 0, "rejected_count": 0, "failed_count": 0},
            "runtime": {"schema_version": "r", "configured": True, "state": "ready"},
            "health": {"status": "ok", "active_session": True},
        }

        preview_tree = ast.parse(subject.HELD_READONLY_CAPTURE)
        stable_node = next(node for node in preview_tree.body
                           if isinstance(node, ast.FunctionDef) and node.name == "stable")
        preview_namespace = {}
        exec(compile(ast.Module(body=[stable_node], type_ignores=[]), "held-preview-stable", "exec"),
             preview_namespace)
        stable = preview_namespace["stable"]
        self.assertNotEqual(stable(snapshot, first_sha), stable(snapshot, second_sha))
        same_wire_sha = hashlib.sha256(bytes(first_wire)).hexdigest()
        self.assertEqual(stable(snapshot, first_sha), stable(snapshot, same_wire_sha))

        closure_tree = ast.parse(subject.HELD_API_QUIESCE_CAPTURE_BODY)
        context_node = next(node for node in closure_tree.body
                            if isinstance(node, ast.FunctionDef) and node.name == "held_api_context")
        closure_namespace = {}
        exec(compile(ast.Module(body=[context_node], type_ignores=[]), "held-quiescence-context", "exec"),
             closure_namespace)
        context = closure_namespace["held_api_context"]
        self.assertEqual(context(snapshot, first_sha)["scene_sha256"], first_sha)
        self.assertNotEqual(context(snapshot, first_sha), context(snapshot, second_sha))
        self.assertEqual(context(snapshot, first_sha), context(snapshot, same_wire_sha))

    def test_scene_pin_uses_raw_api_bytes_for_nm_exponent_scalars(self):
        request_value, proofs = valid_proof_chain()
        # These exact nm exponent lexemes are present in the captured API SceneDocument.
        raw_scene = (
            b'{"revision":2,"objects":[{"geometry":{"bounds_max":[4e-9,2e-9,1e-9],'
            b'"bounds_min":[-4e-9,-2e-9,-1e-9],"geometry_kind":"Box",'
            b'"geometry_params":{"size":[8e-9,4e-9,2e-9]}},"id":"film",'
            b'"name":"film","role":"magnet"}]}'
        )
        parsed_scene = json.loads(raw_scene)
        raw_sha = hashlib.sha256(raw_scene).hexdigest()
        self.assertNotEqual(canonical(parsed_scene), raw_scene)
        self.assertIn(b"4e-9", raw_scene)
        self.assertNotIn(b"4e-09", raw_scene)

        response = proofs["preflight"]["api_response"]["responses"]["scene"]
        response["raw_base64"] = __import__("base64").b64encode(raw_scene).decode("ascii")
        response["sha256"] = raw_sha
        proofs["preflight"]["api_response"]["snapshot"]["scene"] = parsed_scene
        request_value["accepted"]["accepted_scene_sha256"] = raw_sha

        validated = subject.validate_preflight(proofs["preflight"], request_value["accepted"])
        self.assertEqual(validated["api_response"]["responses"]["scene"]["sha256"], raw_sha)
        plan, _plan_sha = subject.build_preview_plan(
            attempt=request_value["plan"]["attempt"],
            maintenance_request_id=request_value["plan"]["maintenance_request_id"],
            source_scope=request_value["source_scope"],
            accepted=request_value["accepted"],
            preflight=validated,
            inventory=proofs["inventory"],
        )
        self.assertEqual(plan["current"]["scene_sha256"], raw_sha)

        parsed_only_digest = hashlib.sha256(canonical(parsed_scene)).hexdigest()
        self.assertNotEqual(parsed_only_digest, raw_sha)
        proofs["preflight"]["api_response"]["responses"]["scene"]["sha256"] = parsed_only_digest
        with self.assertRaises(BuildControlError):
            subject.validate_preflight(proofs["preflight"], request_value["accepted"])


class ApiQuiescenceIntentContracts(unittest.TestCase):
    def setUp(self):
        self.value, self.proofs = valid_proof_chain()
        self.plan, self.plan_sha256 = subject.build_preview_plan(
            attempt=self.value["plan"]["attempt"],
            maintenance_request_id=self.value["plan"]["maintenance_request_id"],
            source_scope=self.value["source_scope"],
            accepted=self.value["accepted"],
            preflight=self.proofs["preflight"],
            inventory=self.proofs["inventory"],
        )

    def prepare(self, *, preflight=None, inventory=None, source_scope=None, plan_sha256=None):
        return subject.prepare_api_quiescence_intent(
            attempt=self.value["plan"]["attempt"],
            maintenance_request_id=self.value["plan"]["maintenance_request_id"],
            plan_sha256=plan_sha256 or self.plan_sha256,
            source_scope=source_scope or self.value["source_scope"],
            accepted=self.value["accepted"],
            preflight=preflight or self.proofs["preflight"],
            inventory=inventory or self.proofs["inventory"],
        )

    def test_intent_pins_exact_accepted_scope_and_native_fences(self):
        intent, raw, digest = self.prepare()
        validated = subject.validate_api_quiescence_intent(intent, expected_sha256=digest)
        self.assertEqual(validated, intent)
        self.assertEqual(raw, subject.canonical(intent) + b"\n")
        self.assertEqual(subject.sha(raw), digest)
        self.assertEqual(intent["plan_sha256"], self.plan_sha256)
        self.assertEqual(intent["plan"]["accepted"]["session_epoch"], 1)
        self.assertEqual(intent["plan"]["current"]["api_instance_id"], OLD_API)
        self.assertEqual(intent["plan"]["native"]["api_pin"], self.proofs["preflight"]["api_pin"])
        self.assertEqual(intent["plan"]["native"]["config_sha256"],
                         self.proofs["preflight"]["native_config_sha256"])
        self.assertEqual(intent["plan"]["inventory"], self.proofs["inventory"]["before"])

    def test_intent_rejects_pid_config_scene_receipt_and_source_drift_after_preview(self):
        cases = []
        changed_pid = copy.deepcopy(self.proofs["preflight"])
        changed_pid["api_pin"]["start_token"] = "99999"
        cases.append(("pid start token", changed_pid, self.proofs["inventory"], self.value["source_scope"]))

        changed_config = copy.deepcopy(self.proofs["preflight"])
        changed_config["native_config_sha256"] = "e" * 64
        cases.append(("native config", changed_config, self.proofs["inventory"], self.value["source_scope"]))

        changed_scene = copy.deepcopy(self.proofs["preflight"])
        changed_scene["api_response"]["snapshot"]["scene"]["objects"].append({"id": "drift"})
        cases.append(("scene", changed_scene, self.proofs["inventory"], self.value["source_scope"]))

        changed_receipt = copy.deepcopy(self.proofs["preflight"])
        changed_receipt["commands"]["request_receipt"]["request_id"] = "f" * 36
        cases.append(("request receipt", changed_receipt, self.proofs["inventory"], self.value["source_scope"]))

        changed_scope = copy.deepcopy(self.value["source_scope"])
        changed_scope["backend_started_at"] = "2026-11-13T15:00:00Z"
        cases.append(("source incarnation", self.proofs["preflight"], self.proofs["inventory"], changed_scope))

        for label, preflight, inventory, source_scope in cases:
            with self.subTest(label=label), self.assertRaises(BuildControlError):
                self.prepare(preflight=preflight, inventory=inventory, source_scope=source_scope)

    def test_intent_rejects_plan_fence_change_and_noncanonical_mutation(self):
        with self.assertRaises(BuildControlError):
            self.prepare(plan_sha256="f" * 64)
        intent, _raw, digest = self.prepare()
        mutated = copy.deepcopy(intent)
        mutated["plan"]["accepted"]["session_epoch"] = 2
        with self.assertRaises(BuildControlError):
            subject.validate_api_quiescence_intent(mutated, expected_sha256=digest)

    def test_native_store_and_diagnostic_capability_are_checked_before_pidfd_signal(self):
        script = subject.held_api_quiescence_capture_program()
        tree = ast.parse(script)
        selected = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name in {"accepted_store_binding_for", "process_store_identity_matches"}]
        self.assertEqual({node.name for node in selected},
                         {"accepted_store_binding_for", "process_store_identity_matches"})
        namespace = {"hashlib": hashlib, "os": os, "pathlib": __import__("pathlib"), "re": __import__("re")}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "held-store-identity", "exec"), namespace)

        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary) / "session-store"
            store.mkdir()
            binding = namespace["accepted_store_binding_for"](store)
            self.assertEqual(binding, hashlib.sha256(
                b"fullmag.accepted-store-binding.v1\0" + os.fsencode(str(store) + "/")
            ).hexdigest())
            ready_process = {
                "accepted_store": str(store),
                "bootstrap": {
                    "schema": "fullmag.docker-accepted-store-bootstrap.v1",
                    "store_root": str(store),
                    "binding": binding,
                },
                # The current ready-process producer omits this false-only capability.
            }
            matches = namespace["process_store_identity_matches"]
            self.assertTrue(matches(ready_process, store, binding))

            changed_store = copy.deepcopy(ready_process)
            changed_store["accepted_store"] = str(store / "other")
            changed_binding = copy.deepcopy(ready_process)
            changed_binding["bootstrap"]["binding"] = "0" * 64
            with self.subTest(reason="accepted store path"):
                self.assertFalse(matches(changed_store, store, binding))
            with self.subTest(reason="accepted store bootstrap binding"):
                self.assertFalse(matches(changed_binding, store, binding))
            for diagnostic in (True, 0, None):
                changed_capability = copy.deepcopy(ready_process)
                changed_capability["api_diagnostic_only"] = diagnostic
                with self.subTest(diagnostic=diagnostic):
                    self.assertFalse(matches(changed_capability, store, binding))

        preview = subject.HELD_READONLY_CAPTURE
        self.assertIn("process_store_identity_matches(process,paths.store,native_binding)", preview)
        authority = script.split("def read_held_authority(intent):", 1)[1].split("request_raw=", 1)[0]
        self.assertIn('process_store_identity_matches(process,paths.store,native["accepted_store_binding"])',
                      authority)
        self.assertIn('read_held_authority(intent)', script)
        self.assertLess(preview.index("process_store_identity_matches(process,paths.store,native_binding)"),
                        preview.index("preflight={"))
        self.assertIn("api_diagnostic_only", preview)
        self.assertLess(authority.index(
            'process_store_identity_matches(process,paths.store,native["accepted_store_binding"])'),
            authority.index("detail_is_pinned_404(accepted)"))
        self.assertLess(script.index('before_fences,owner,identity,inventory=read_held_authority(intent)'),
                        script.index('retained_raw,retained=pidfd_close_api('))

    def test_publishing_intent_is_immutable_and_idempotent(self):
        intent, raw, digest = self.prepare()

        class Control:
            namespace = ""
            namespace_registry_sha256 = None

            def __init__(self):
                self.records = {}
                self.writes = []

            def read_bytes(self, path, optional=False):
                value = self.records.get(path)
                if value is None and not optional:
                    raise BuildControlError("missing control record")
                return value

            def write_bytes(self, path, data):
                self.records[path] = data
                self.writes.append(path)

        control = Control()
        inputs = subject.publish_api_quiescence_inputs(
            control, MAINTENANCE_ID,
            source_scope=self.value["source_scope"], accepted=self.value["accepted"],
            preflight=self.proofs["preflight"], inventory=self.proofs["inventory"],
        )
        self.assertEqual(inputs["preflight"]["sha256"], intent["preflight_sha256"])
        self.assertEqual(inputs["inventory"]["sha256"], intent["inventory_sha256"])
        path, written_sha = subject.publish_api_quiescence_intent(
            control, intent, expected_plan_sha256=self.plan_sha256,
        )
        self.assertEqual(written_sha, digest)
        self.assertEqual(control.records["runtime-control/" + path], raw)
        self.assertEqual(subject.publish_api_quiescence_intent(
            control, intent, expected_plan_sha256=self.plan_sha256,
        ), (path, digest))
        self.assertEqual(control.writes, [
            "runtime-control/held-ui-materialization/" + MAINTENANCE_ID + "/preflight.json",
            "runtime-control/held-ui-materialization/" + MAINTENANCE_ID + "/inventory.json",
            "runtime-control/" + path,
        ])
        changed = copy.deepcopy(intent)
        changed["plan"]["plan_sha256"] = "0" * 64
        with self.assertRaises(BuildControlError):
            subject.publish_api_quiescence_intent(
                control, changed, expected_plan_sha256=self.plan_sha256,
            )

    def test_held_capture_reuses_one_pidfd_primitive_without_terminal_catalog_inspection(self):
        import ast

        script = subject.held_api_quiescence_capture_program()
        ast.parse(script)
        self.assertEqual(script.count("signal.pidfd_send_signal("), 1)
        self.assertIn("pidfd_close_api(", script)
        self.assertNotIn("service-inspect-terminal-run", script)
        self.assertIn("request_scope_epoch", script)
        self.assertIn("run_intent.json", script)
        self.assertIn("native_config_sha256", script)
        self.assertIn('run_intent.get("payload_sha256")', script)
        self.assertNotIn("digest(canon(spec))", script)

    def test_capture_accepts_only_exact_receipt_and_before_after_fences(self):
        from docker_volume_native_terminal_stop import QUIESCE_SCHEMA

        intent, raw, intent_sha = self.prepare()
        api_pin = intent["plan"]["native"]["api_pin"]
        retained = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "failed_outcome_retained",
            "accepted_store": "/state/runs/docker-all/session-store",
            "api_pid": api_pin["pid"],
            "api_exit_code": -15,
            "api_diagnostic_only": False,
            "error": "Fullmag API exited unexpectedly (-15)",
            "bootstrap": {
                "schema": "fullmag.docker-accepted-store-bootstrap.v1",
                "store_root": "/state/runs/docker-all/session-store",
                "binding": intent["plan"]["native"]["accepted_store_binding"],
            },
            "service_owner": owner(),
        }
        retained_sha = hashlib.sha256(canonical(retained) + b"\n").hexdigest()
        receipt = {
            "schema": QUIESCE_SCHEMA,
            "intent_sha256": intent_sha,
            "api_pin": api_pin,
            "api_closed": True,
            "signal": "SIGTERM",
            "retained_process": retained,
            "retained_process_sha256": retained_sha,
        }
        captured = {
            "receipt": receipt,
            "fences": subject._expected_api_quiescence_fences(intent, retained_sha),
        }
        expected_backend = self.value["source_scope"]["backend_container_id"]
        intent_path = "runtime-control/" + subject.quiescence_intent_relative(MAINTENANCE_ID)
        control_root = "runtime-control/held-ui-materialization/" + MAINTENANCE_ID + "/"
        durable_records = {
            control_root + "preflight.json": canonical(self.proofs["preflight"]) + b"\n",
            control_root + "inventory.json": canonical(self.proofs["inventory"]) + b"\n",
            intent_path: raw,
        }
        durable_control = DurableHeldControl(durable_records, self.value["source_scope"])
        operation = production_held_stop_operation(durable_control, "c" * 32)

        def helper_capture(command, *, data=b"", timeout=90, **_kwargs):
            self.assertEqual(tuple(command[:2]), ("docker", "run"))
            self.assertNotIn(control_root + "api-quiescence-start.json", durable_records)
            durable_records[control_root + "api-quiescence-start.json"] = data
            return SimpleNamespace(stdout=b"CLAIMED\n", returncode=0)

        def capture(*args, **kwargs):
            self.assertEqual(args[:4], ("exec", "-i", expected_backend, "python3"))
            return SimpleNamespace(stdout=canonical(captured), returncode=0)

        with patch("docker_build_control.bounded_capture", side_effect=helper_capture) as helper, \
             patch("docker_build_control.docker_capture", side_effect=capture) as docker:
            result = subject.capture_held_api_quiescence(
                durable_control, expected_backend, intent,
                operation=operation, expected_plan_sha256=self.plan_sha256,
                expected_intent_sha256=intent_sha,
            )
        self.assertEqual(result, receipt)
        self.assertIn(b"\"intent_sha256\"", docker.call_args_list[-1].kwargs["data"])
        self.assertEqual(sum(call.args[:2] == ("exec", "-i") for call in docker.call_args_list), 1)
        self.assertFalse(operation["daemon_pending"])
        claim = json.loads(durable_records[control_root + "api-quiescence-start.json"])
        self.assertEqual(claim["state"], "started")
        self.assertEqual(claim["intent_sha256"], intent_sha)
        claim_command = helper.call_args.args[0]
        claim_script = claim_command[-1]
        self.assertEqual(tuple(claim_command[:2]), ("docker", "run"))
        self.assertIn("set -C", claim_script)
        self.assertIn("head -c 16385", claim_script)
        self.assertIn("sha256sum", claim_script)
        self.assertIn("sync -f", claim_script)
        self.assertNotIn("python", claim_script)
        self.assertEqual(docker.call_count, 1)
        self.assertEqual(operation["receipt"]["held_ui_api_quiescence_claim"]["state"],
                         "consumed")

    def test_timeout_spends_api_quiescence_claim_and_never_replays_signal(self):
        intent, raw, intent_sha = self.prepare()
        control_root = "runtime-control/held-ui-materialization/" + MAINTENANCE_ID + "/"
        durable_records = {
            control_root + "preflight.json": canonical(self.proofs["preflight"]) + b"\n",
            control_root + "inventory.json": canonical(self.proofs["inventory"]) + b"\n",
            "runtime-control/" + subject.quiescence_intent_relative(MAINTENANCE_ID): raw,
        }
        control = DurableHeldControl(durable_records, self.value["source_scope"])
        operation = production_held_stop_operation(control, "c" * 32)
        api_execs = []
        claim_helpers = []

        def helper_capture(command, *, data=b"", timeout=90, **_kwargs):
            claim_helpers.append(tuple(command))
            self.assertEqual(tuple(command[:2]), ("docker", "run"))
            claim_path = control_root + "api-quiescence-start.json"
            self.assertNotIn(claim_path, durable_records)
            durable_records[claim_path] = data
            return SimpleNamespace(stdout=b"CLAIMED\n", returncode=0)

        def capture(*args, **kwargs):
            if args[0] == "exec":
                api_execs.append(args)
                raise DockerObservationBudgetExceeded("simulated Docker capture timeout")
            self.fail("unexpected Docker call")

        with patch("docker_build_control.bounded_capture", side_effect=helper_capture), \
             patch("docker_build_control.docker_capture", side_effect=capture):
            with self.assertRaises(BuildControlError):
                subject.capture_held_api_quiescence(
                    control, self.value["source_scope"]["backend_container_id"], intent,
                    operation=operation, expected_plan_sha256=self.plan_sha256,
                    expected_intent_sha256=intent_sha,
                )
            # The timed-out operation remains daemon-pending; even a later
            # properly admitted operation cannot spend this request's claim again.
            with self.assertRaisesRegex(BuildControlError, "active group held-stop operation"):
                subject.capture_held_api_quiescence(
                    control, self.value["source_scope"]["backend_container_id"], intent,
                    operation=operation, expected_plan_sha256=self.plan_sha256,
                    expected_intent_sha256=intent_sha,
                )
            recovered_operation = production_held_stop_operation(control, "d" * 32)
            with self.assertRaisesRegex(BuildControlError, "start claim"):
                subject.capture_held_api_quiescence(
                    control, self.value["source_scope"]["backend_container_id"], intent,
                    operation=recovered_operation, expected_plan_sha256=self.plan_sha256,
                    expected_intent_sha256=intent_sha,
                )
        self.assertEqual(len(claim_helpers), 1)
        self.assertEqual(claim_helpers[0][:2], ("docker", "run"))
        self.assertNotIn("python", claim_helpers[0][-1])
        self.assertEqual(len(api_execs), 1)
        self.assertTrue(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["held_ui_api_quiescence_claim"]["state"],
                         "outcome-unknown")


class PreSignalStopContracts(unittest.TestCase):
    def setUp(self):
        request_value, self.proofs = valid_proof_chain()
        self.attempt = request_value["plan"]["attempt"]
        self.maintenance_id = request_value["plan"]["maintenance_request_id"]
        self.run_id = request_value["accepted"]["run_id"]
        self.source_scope = request_value["source_scope"]
        self.accepted = request_value["accepted"]
        self.plan, self.plan_sha256 = subject.build_preview_plan(
            attempt=self.attempt,
            maintenance_request_id=self.maintenance_id,
            source_scope=self.source_scope,
            accepted=self.accepted,
            preflight=self.proofs["preflight"],
            inventory=self.proofs["inventory"],
        )
        self.intent, self.intent_raw, self.intent_sha256 = subject.prepare_api_quiescence_intent(
            attempt=self.attempt,
            maintenance_request_id=self.maintenance_id,
            plan_sha256=self.plan_sha256,
            source_scope=self.source_scope,
            accepted=self.accepted,
            preflight=self.proofs["preflight"],
            inventory=self.proofs["inventory"],
        )
        self.stop_attempt = "f" * 32
        self.control_root = subject.request_relative(self.maintenance_id).rsplit("/", 1)[0]
        inputs = {
            "attempt": self.attempt,
            "source_root": self.source_scope["source_root"],
            "config_sha256": self.source_scope["runtime_config_sha256"],
            "source_scope": self.source_scope,
            "maintenance_request_id": self.maintenance_id,
            "plan_sha256": self.plan_sha256,
            "run_id": self.run_id,
            "accepted_run_id": self.run_id,
            "capture_held_ui_materialization": True,
        }
        self.parent_terminal = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "held-ui-materialization-stop",
            "attempt": self.stop_attempt,
            "state": "failed-confirmed",
            "held_ui_stop_stage": "frontend-stopped",
            "error": subject.PRE_SIGNAL_STOP_FAILURE,
            "api_quiescence_intent_sha256": self.intent_sha256,
            "compose_project": self.source_scope["compose_project"],
            "control_volume": self.source_scope["control_volume"],
            "inputs": inputs,
        }
        self.terminal_relative = (
            "held-ui-materialization-stop/attempts/" + self.stop_attempt + "/terminal.json"
        )
        self.records = {
            "runtime-control/" + self.control_root + "/preflight.json": encoded_record(
                self.proofs["preflight"]),
            "runtime-control/" + self.control_root + "/inventory.json": encoded_record(
                self.proofs["inventory"]),
            "runtime-control/" + subject.quiescence_intent_relative(self.maintenance_id):
                self.intent_raw,
            self.terminal_relative: encoded_record(self.parent_terminal),
        }
        self.control = DurableHeldControl(self.records, self.source_scope)

    def validate_parent(self, *, terminal_sha256=None):
        terminal_raw = self.records[self.terminal_relative]
        return subject.validate_pre_signal_stop_parent(
            self.control,
            stop_attempt=self.stop_attempt,
            terminal_sha256=terminal_sha256 or subject.sha(terminal_raw),
            expected_attempt=self.attempt,
            expected_maintenance_request_id=self.maintenance_id,
            expected_run_id=self.run_id,
            expected_plan_sha256=self.plan_sha256,
        )

    def test_exact_confirmed_frontend_stopped_failure_reuses_the_saved_intent_basis(self):
        recovered = self.validate_parent()

        self.assertEqual(recovered["terminal_raw"], self.records[self.terminal_relative])
        self.assertEqual(recovered["intent_raw"], self.intent_raw)
        self.assertEqual(recovered["intent"], self.intent)
        self.assertEqual(recovered["proof_refs"]["preflight"]["path"],
                         self.control_root + "/preflight.json")
        self.assertEqual(recovered["proof_refs"]["inventory"]["path"],
                         self.control_root + "/inventory.json")

    def test_parent_terminal_and_no_claim_absence_are_mandatory(self):
        with self.assertRaisesRegex(BuildControlError, "explicit pin"):
            self.validate_parent(terminal_sha256="1" * 64)

        claim_path = "runtime-control/" + subject.quiescence_start_claim_relative(
            self.maintenance_id,
        )
        self.records[claim_path] = b"unknown claim bytes"
        with self.assertRaisesRegex(BuildControlError, "start claim"):
            self.validate_parent()

    def test_parent_error_stage_or_immutable_plan_drift_is_rejected(self):
        self.parent_terminal["held_ui_stop_stage"] = "api-quiescence-start-unknown"
        changed = encoded_record(self.parent_terminal)
        self.records[self.terminal_relative] = changed
        with self.assertRaisesRegex(BuildControlError, "exact no-API-exec frontend stop"):
            self.validate_parent()

        self.parent_terminal["held_ui_stop_stage"] = "frontend-stopped"
        self.parent_terminal["inputs"]["plan_sha256"] = "0" * 64
        self.records[self.terminal_relative] = encoded_record(self.parent_terminal)
        with self.assertRaisesRegex(BuildControlError, "exact no-API-exec frontend stop"):
            self.validate_parent()


class PreviewPlanLifecycleContracts(unittest.TestCase):
    def test_apply_dispatches_only_to_typed_driver(self):
        args = SimpleNamespace(apply=True, preview=False)
        result = {"state": "restored"}
        with patch.object(volume_dev, "require_host") as require_host, \
             patch.object(volume_dev, "_apply_held_ui_materialization", return_value=result) as apply:
            self.assertEqual(volume_dev._run_held_ui_materialization(args, controller=subject), result)
        apply.assert_called_once_with(args, controller=subject)
        require_host.assert_not_called()

    def test_conflicting_apply_mode_is_rejected_before_observation(self):
        args = SimpleNamespace(apply=True, preview=True)
        with patch.object(volume_dev, "require_host") as require_host:
            with self.assertRaisesRegex(BuildControlError, "exact private --apply action"):
                volume_dev._run_held_ui_materialization(args, controller=subject)
        require_host.assert_not_called()

    def test_preview_inspects_pinned_dev_state_without_control_operation_or_stop(self):
        attempt = "a" * 32
        request_id = MAINTENANCE_ID
        backend_id, frontend_id = "1" * 64, "2" * 64
        backend_image, frontend_image = "sha256:" + "3" * 64, "sha256:" + "4" * 64
        document = {"name": "project-p22", "services": {
            "backend": {"image": backend_image}, "frontend": {"image": frontend_image},
        }}
        config_sha = hashlib.sha256(subject.canonical(document)).hexdigest()
        previous = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "succeeded", "attempt": attempt, "compose_project": "project-p22",
            "control_volume": "control-p22", "control_namespace": "",
            "namespace_registry_sha256": None, "config_sha256": config_sha,
            "inputs": {"source_root": "/repo/task"},
            "backend_container": backend_id, "frontend_container": frontend_id,
            "state_root": "/runtime/state",
        }
        containers = {}
        for service, identifier, image in (
            ("backend", backend_id, backend_image), ("frontend", frontend_id, frontend_image),
        ):
            containers[identifier] = {
                "Id": identifier, "Image": image,
                "Config": {"Labels": {"com.docker.compose.project": "project-p22",
                                        "com.docker.compose.service": service,
                                        "org.fullmag.source.worktree-id": "wt-p22"}},
                "State": {"Running": True, "StartedAt": "2026-11-13T15:00:00Z",
                          "Health": {"Status": "healthy"}},
            }

        class FakeControl:
            project = "project-p22"
            volume = "control-p22"
            namespace = ""
            namespace_registry_sha256 = None
            shared_labels = {}
            identity = {"project_name": "project-p22", "worktree_id": "wt-p22"}

            def __init__(self, *_args):
                pass

            def read(self, relative):
                return previous if relative.endswith("/terminal.json") else document

            def operation(self, *_args, **_kwargs):
                raise AssertionError("preview opened a control operation")

        docker_calls = []

        def capture(*args, **_kwargs):
            docker_calls.append(args)
            if args[:2] == ("volume", "inspect"):
                return SimpleNamespace(returncode=0, stdout=b'[{"Name":"control-p22","Driver":"local","Options":{},"Labels":{}}]')
            raise AssertionError("unexpected Docker operation: " + repr(args))

        def docker_text(*args, **_kwargs):
            if args[:2] == ("image", "inspect"):
                return json.dumps([{"Id": args[2], "Config": {}}])
            if args[:1] == ("inspect",):
                return json.dumps([containers[args[1]]])
            raise AssertionError("unexpected Docker observation: " + repr(args))

        host = SimpleNamespace(OWNER_NAME=".owner", read_owned_regular=lambda _path: b"stable-owner")
        state_path = Path(__file__).resolve().parent
        controller = SimpleNamespace(
            capture_readonly_preflight=lambda *_args, **_kwargs: ({"run_id": RUN_ID}, {}, {}),
            build_preview_plan=lambda **_kwargs: ({"schema": "preview-test"}, "d" * 64),
            _require=subject._require,
        )
        args = SimpleNamespace(
            apply=False, preview=True, attempt=attempt, config_sha256=config_sha,
            run_id=RUN_ID, request_id=request_id, repo_root=str(Path(__file__).resolve().parent),
            source_root="/repo/task", port=3243,
        )
        with patch.object(volume_dev, "require_host"), \
             patch("docker_dev._select_source", return_value=(Path("/repo/task"), {"runtime_root": Path("/runtime")})), \
             patch("docker_dev._compose_identity", return_value={"project_name": "project-p22", "worktree_id": "wt-p22"}), \
             patch("docker_build_control.toolchain_configuration", return_value={
                 "services": {"fem-gpu-toolchain": {"build": {"args": {"FULLMAG_CUDA_BASE_IMAGE": "sha256:" + "5" * 64}}}}
             }), \
             patch.object(volume_dev, "BuildControl", FakeControl), \
             patch.object(volume_dev, "docker_capture", side_effect=capture), \
             patch.object(volume_dev, "docker_text", side_effect=docker_text), \
             patch.object(volume_dev, "compose_capture", side_effect=lambda *_args, **_kwargs: (backend_id if _args[-1] == "backend" else frontend_id).encode()), \
             patch.object(volume_dev, "_validate_retained_service"), \
             patch.object(volume_dev, "_assert_private_restart_network"), \
             patch.object(volume_dev, "_session_host", return_value=host), \
             patch.object(volume_dev.storage, "validate_path", return_value=state_path), \
             patch.object(volume_dev, "_certificate_path", return_value=state_path / "certificate.json"), \
             patch.object(volume_dev, "_retained_certificate", return_value={} ), \
             patch("docker_volume_stop_diagnostic._port_matches"):
            result = volume_dev._run_held_ui_materialization(args, controller=controller)
        self.assertEqual(result["state"], "preview-passed")
        self.assertTrue(result["apply_available"])
        self.assertEqual(docker_calls, [("volume", "inspect", "control-p22")])


if __name__ == "__main__":
    unittest.main()
