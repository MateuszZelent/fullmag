"""Pure held UI materialization request contracts; no Docker or volume access."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_volume_held_ui_materialization as subject
import docker_volume_dev as volume_dev
from docker_build_control import BuildControlError


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
           "status": "waiting_for_compute"}
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
    ready_owner = owner()
    retained_process = {"schema": "fullmag.docker-process-tree.v1",
                        "state": "failed_outcome_retained",
                        "error": "Fullmag API exited unexpectedly (-15)",
                        "api_pid": 200, "api_exit_code": -15, "api_diagnostic_only": False,
                        "accepted_store": "/state/runs/docker-all/session-store",
                        "service_owner": ready_owner}
    api_pin = copy.deepcopy(preflight["api_pin"])
    quiescence = {"schema": "fullmag.native-terminal-api-quiescence.v1",
                  "intent_sha256": "e" * 64, "api_pin": api_pin, "api_closed": True,
                  "signal": "SIGTERM", "retained_process": retained_process,
                  "retained_process_sha256": hashlib.sha256(
                      canonical(retained_process) + b"\n").hexdigest()}
    terminal_owner = owner("drained", "exited_success")
    native_drain = {"schema": "fullmag.docker-process-tree.v1", "state": "drained",
                    "accepted_store": "/state/runs/docker-all/session-store",
                    "api_exit_code": -15, "api_pid": 200,
                    "error": "Fullmag API exited unexpectedly (-15)",
                    "api_diagnostic_only": False,
                    "service_owner": ready_owner, "terminal_service_owner": terminal_owner}
    stop_attempt = value["stop_authority"]["stop_attempt"]
    stopped = {
        "backend": {"id": source["backend_container_id"], "image_id": "sha256:" + "5" * 64,
                    "started_at": source["backend_started_at"], "running": False},
        "frontend": {"id": source["frontend_container_id"], "image_id": "sha256:" + "6" * 64,
                     "started_at": source["frontend_started_at"], "running": False},
    }
    terminal = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "held-ui-materialization-stop", "attempt": stop_attempt,
        "state": "succeeded", "idle_backend_stopped": True,
        "compose_project": source["compose_project"], "control_volume": source["control_volume"],
        "control_namespace": source["namespace"],
        "namespace_registry_sha256": source["namespace_registry_sha256"],
        "config_sha256": source["runtime_config_sha256"],
        "inputs": {"source_root": source["source_root"],
                    "config_sha256": source["runtime_config_sha256"],
                    "maintenance_request_id": value["plan"]["maintenance_request_id"],
                    "plan_sha256": value["plan"]["plan_sha256"], "run_id": accepted["run_id"]},
        "backend_container": source["backend_container_id"],
        "frontend_container": source["frontend_container_id"],
        "backend_started_at": source["backend_started_at"],
        "frontend_started_at": source["frontend_started_at"],
        "held_ui_stop_services": stopped,
        "held_ui_stop_services_sha256": hashlib.sha256(canonical(stopped) + b"\n").hexdigest(),
    }
    proof_map = {"preflight": preflight, "api_quiescence": quiescence,
                 "native_drain": native_drain, "inventory": inventory, "terminal": terminal}
    for key, proof in proof_map.items():
        path = value["stop_authority"][key]["path"]
        value["stop_authority"][key]["sha256"] = hashlib.sha256(encoded_record(proof)).hexdigest()
    return value, proof_map


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


class CompletedProofContracts(unittest.TestCase):
    def setUp(self):
        self.value, self.proofs = valid_proof_chain()

    def test_completed_proof_chain_binds_scope_api_owner_intent_and_drain(self):
        raw = {self.value["stop_authority"][key]["path"]: encoded_record(proof)
               for key, proof in self.proofs.items()}
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
            raw = {value["stop_authority"][key]["path"]: encoded_record(proof)
                   for key, proof in proofs.items()}
            with self.assertRaises(BuildControlError):
                subject.validate_stop_proofs(value, raw.__getitem__)

    def test_inventory_requires_exact_accepted_intent_and_execution_input(self):
        for field, change in (
            ("run_files", lambda side: side["run_files"][1].update(sha256="f" * 64)),
            ("execution_input", lambda side: side["execution_input"].update(sha256="f" * 64)),
        ):
            value, proofs = valid_proof_chain()
            change(proofs["inventory"]["before"])
            change(proofs["inventory"]["after"])
            raw = {value["stop_authority"][key]["path"]: encoded_record(proof)
                   for key, proof in proofs.items()}
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                subject.validate_stop_proofs(value, raw.__getitem__)

    def test_terminal_must_bind_both_exact_stopped_service_incarnations(self):
        value, proofs = valid_proof_chain()
        proofs["terminal"]["held_ui_stop_services"]["frontend"]["started_at"] = "changed"
        proofs["terminal"]["held_ui_stop_services_sha256"] = hashlib.sha256(
            canonical(proofs["terminal"]["held_ui_stop_services"]) + b"\n").hexdigest()
        raw = {value["stop_authority"][key]["path"]: encoded_record(proof)
               for key, proof in proofs.items()}
        with self.assertRaises(BuildControlError):
            subject.validate_stop_proofs(value, raw.__getitem__)


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

    def test_apply_fails_before_any_host_or_docker_observation(self):
        args = SimpleNamespace(apply=True, preview=False)
        with patch.object(volume_dev, "require_host") as require_host:
            with self.assertRaisesRegex(BuildControlError, "not available in this read-only preview slice"):
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
        self.assertFalse(result["apply_available"])
        self.assertEqual(docker_calls, [("volume", "inspect", "control-p22")])


if __name__ == "__main__":
    unittest.main()
