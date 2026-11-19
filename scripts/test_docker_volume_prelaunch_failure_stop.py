from __future__ import annotations

import copy
import ast
import hashlib
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import docker_volume_prelaunch_failure_stop as subject
import docker_dev


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def task_id(run, step):
    return "task-" + sha((run + "\0" + step).encode())


def fixture():
    run = "run-abc"
    api = "11111111-1111-4111-8111-111111111111"
    session = "session-abc"
    steps = [
        {"step_id": "relax-a", "enabled": True, "kind": {"kind": "primitive", "stage_kind": "relax"},
         "completion_dependencies": []},
        {"step_id": "relax-b", "enabled": True, "kind": {"kind": "primitive", "stage_kind": "relax"},
         "completion_dependencies": ["relax-a"]},
        {"step_id": "relax-c", "enabled": True, "kind": {"kind": "primitive", "stage_kind": "relax"},
         "completion_dependencies": ["relax-b"]},
    ]
    study = {"schema_version": "study_plan.v3", "study_id": "study-abc", "revision": 1, "steps": steps}
    study_raw = canonical(study)
    study_ref = sha(study_raw)
    catalog_ref = "b" * 64
    spec = {
        "run_id": run,
        "snapshot": {"project_id": "project-abc"},
        "study": {"study_id": "study-abc", "plan_sha256": study_ref},
        "study_catalog_sha256": catalog_ref,
        "parameters": {"live_workspace": {
            "session_id": session, "api_instance_id": api, "session_epoch": 3,
            "scene_revision": 7, "request_idempotency_key": "startup-request",
            "command_id": "startup-request",
            "command": {"kind": "startup_script", "request_id": "startup-request", "source_sha256": "c" * 64},
        }},
    }
    spec_sha = sha(canonical(spec))
    intent = {
        "schema_version": "run_intent.v1", "run_id": run, "idempotency_key": "submit-abc",
        "payload_sha256": spec_sha, "accepted_at": "2026-11-07T12:00:00Z", "specification": spec,
        "definition_object_ref": None, "study_object_ref": study_ref,
        "study_catalog_object_ref": catalog_ref, "asset_object_refs": {},
    }
    start_release = {
        "schema_version": "accepted_run_start_release.v1", "run_id": run,
        "specification_sha256": spec_sha, "request_id": "startup-request",
        "released_at": "2026-11-07T12:01:00Z",
    }
    start_release_raw = json.dumps(start_release, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    tasks = [
        {"task_id": task_id(run, "relax-a"), "input_fingerprint": "d" * 64,
         "lifecycle": "failed", "readiness": {"state": "ready"}, "observation": "disconnected",
         "attempt_id": "attempt-a", "ownership_epoch": 1, "resolved_input_fingerprint": None,
         "artifact_ids": [], "resource_id": "cpu", "coordinator_watermark": None, "coordinator_genesis": None},
        {"task_id": task_id(run, "relax-b"), "input_fingerprint": "e" * 64,
         "lifecycle": "accepted", "readiness": {"state": "blocked", "reason": "awaiting dependency resolution and runtime admission"},
         "observation": None, "attempt_id": None, "ownership_epoch": None,
         "resolved_input_fingerprint": None, "artifact_ids": [], "resource_id": None,
         "coordinator_watermark": None, "coordinator_genesis": None},
        {"task_id": task_id(run, "relax-c"), "input_fingerprint": "f" * 64,
         "lifecycle": "accepted", "readiness": {"state": "blocked", "reason": "awaiting dependency resolution and runtime admission"},
         "observation": None, "attempt_id": None, "ownership_epoch": None,
         "resolved_input_fingerprint": None, "artifact_ids": [], "resource_id": None,
         "coordinator_watermark": None, "coordinator_genesis": None},
    ]
    run_catalog = {"schema_version": "run_catalog.v1", "run_id": run, "revision": 9,
                   "updated_at": "2026-11-07T12:03:00Z", "tasks": tasks}
    host_policy = {"schema_version": "host_resource_ledger_policy.v3", "host_id": "host-abc",
                   "revision": 1, "owner_epoch": 1, "topology_sha256": "3" * 64,
                   "allowed_cpu_ids": [], "total_budget": {
                       "cpu_millis": 1000, "memory_bytes": 1024, "gpu_memory_bytes": 0, "storage_bytes": 1024}}
    lease = {"schema_version": "resource_lease.v1", "resource_id": "cpu", "kind": "cpu",
             "budget": {"cpu_millis": 1000, "memory_bytes": 1024, "gpu_memory_bytes": 0, "storage_bytes": 1024},
             "run_id": run, "task_id": tasks[0]["task_id"], "attempt_id": "attempt-a",
             "ownership_epoch": 1, "lease_token": "lease-" + "e" * 32, "state": "released",
             "acquired_at": "2026-11-07T12:02:00Z", "heartbeat_at": "2026-11-07T12:02:01Z",
             "heartbeat_sequence": 1, "released_at": "2026-11-07T12:02:02Z", "host_launch_binding": {
                 "schema_version": "host_launch_binding.v1", "ledger_root": "/host-ledger/ledger",
                 "policy": copy.deepcopy(host_policy), "runtime_generation_sha256": None}}
    claim_identity = {"run_id": run, "task_id": tasks[0]["task_id"], "attempt_id": "attempt-a",
                      "ownership_epoch": 1, "lease_token": lease["lease_token"]}
    resolved_input = {"schema_version": "resolved_task_input.v3", "run_id": run,
                      "task_id": tasks[0]["task_id"], "attempt_id": "attempt-a", "ownership_epoch": 1,
                      "specification_fingerprint": "4" * 64, "plan_fingerprint": "1" * 64,
                      "requested_execution": {}, "preparation": {}, "inputs": {}}
    applied_prepare = {"schema_version": "worker_protocol.v3", "message_id": "prepare-a", "sequence": 1,
                       "claim": copy.deepcopy(claim_identity),
                       "command": {"kind": "prepare", "resolved_input": resolved_input}}
    applied_start = {"schema_version": "worker_protocol.v3", "message_id": "start-a", "sequence": 2,
                     "claim": copy.deepcopy(claim_identity), "command": {"kind": "start"}}
    applied_heartbeat = {"schema_version": "worker_protocol.v3", "message_id": "heartbeat-a", "sequence": 3,
                         "claim": copy.deepcopy(claim_identity),
                         "command": {"kind": "heartbeat", "lease_heartbeat_sequence": 1}}
    inbox_payload = {"schema_version": "worker_inbox.v1", "claim": copy.deepcopy(claim_identity),
                     "applied": [applied_prepare, applied_start, applied_heartbeat], "pending": None}
    inbox = {"payload_sha256": sha(canonical(inbox_payload)), "payload": inbox_payload}
    started = {"identity": {"schema_version": "fullmag.accepted_worker_execution.v1",
                             "claim": {"run_id": run, "task_id": tasks[0]["task_id"],
                                       "attempt_id": "attempt-a", "ownership_epoch": 1,
                                       "lease": {"resource_id": "cpu", "kind": "cpu", "budget": lease["budget"],
                                                 "lease_token": lease["lease_token"], "heartbeat_sequence": 0}},
                             "start_message_id": "start-a", "start_sequence": 2,
                             "case_id": "default", "plan_fingerprint": "1" * 64}}
    prelaunch = {"identity": copy.deepcopy(started["identity"]), "error": "project storage preparation failed"}
    exit_receipt = {"schema_version": "worker_process_exit_receipt.v1",
                    "receipt_id": "worker-process-exit-" + "9" * 64,
                    "run_id": run, "task_id": tasks[0]["task_id"], "attempt_id": "attempt-a",
                    "ownership_epoch": 1, "resource_id": "cpu", "lease_token": lease["lease_token"],
                    "lease_heartbeat_sequence": 1, "process_id": 456, "process_start_token": "1234",
                    "status_success": False, "exit_code": 1, "timed_out": False,
                    "stop_requested": False, "failure_reason": "project storage preparation failed",
                    "observed_at": "2026-11-07T12:02:03Z"}
    host_lease = copy.deepcopy(lease)
    reservation = {
        "identity": {"store_id": "sha256:" + "a" * 64, "run_id": run, "task_id": tasks[0]["task_id"],
                     "resource_id": "cpu", "lease_token": lease["lease_token"],
                     "owner": {"kind": "solver", "attempt_id": "attempt-a", "ownership_epoch": 1}},
        "request_sha256": "2" * 64, "host_id": "host-abc", "policy_revision": 1,
        "host_owner_epoch": 1, "runtime_generation_sha256": None, "compute_node_owner_id": None,
        "compute_node_owner_epoch": None, "topology_sha256": "3" * 64,
        "budget": lease["budget"], "exclusive_gpu_uuids": [], "gpu_vram_bytes_by_uuid": {},
        "cpu_ids": [], "release_proof_sha256": None, "state": "released",
        "worker_launch_gate": {"state": "consumed", "token": "12345678-1234-4123-8123-123456789abc"},
        "preparation_launch_gate": None, "preparation_launch_owner": None,
        "node_policy_revision": 0, "scheduling_priority": 0,
        "parallelism": {"kind": "single_process"},
    }
    proof = {"schema_version": "host_resource_release_proof.v1", "kind": "worker",
             "host_id": "host-abc", "store_id": "sha256:" + "a" * 64, "request_sha256": "2" * 64,
             "worker_receipt": exit_receipt, "released_worker_lease": host_lease,
             "preparation_receipt": None, "released_preparation_lease": None,
             "unadmitted_task": None, "preparation_launch_owner": None, "orphan_teardown": None,
             "claimed_interruption": None}
    proof_raw = json.dumps(proof, sort_keys=True, indent=2).encode()
    reservation["release_proof_sha256"] = sha(proof_raw)
    evidence = {
        "schema": "fullmag.prelaunch-failure-locked-evidence.v1", "locked": True,
        "lock_order": ["host-ledger", "session-store"], "run_id": run,
        "store_id": "sha256:" + "a" * 64, "run_intent": intent, "run_catalog": run_catalog,
        "start_release": start_release, "study_plan": study, "study_plan_raw_sha256": study_ref,
        "study_catalog_present": True, "study_catalog_raw_sha256": catalog_ref,
        "run_intent_raw_sha256": sha(canonical(intent)), "run_catalog_raw_sha256": sha(canonical(run_catalog)),
        "start_release_raw_sha256": sha(start_release_raw), "started_raw_sha256": sha(canonical(started)),
        "prelaunch_raw_sha256": sha(canonical(prelaunch)), "inbox_raw_sha256": sha(canonical(inbox)),
        "exit_raw_sha256": sha(canonical(exit_receipt)), "lease_raw_sha256": sha(canonical(lease)),
        "leases": [lease], "preparation_leases": [],
        "worker_exit_receipts": [exit_receipt], "attempts": {tasks[0]["task_id"]: {
            "files": {"worker_execution_started.v1.json": started,
                      "worker_prelaunch_failed.v1.json": prelaunch}, "worker_inbox": inbox}},
        "other_task_attempts_absent": True,
        "host_ledger": {"schema_version": "host_resource_ledger.v4",
                        "policy": copy.deepcopy(host_policy),
                        "reservations": [reservation],
                        "release_proofs": {reservation["release_proof_sha256"]: proof},
                        "release_proof_raw_sha256": {reservation["release_proof_sha256"]: reservation["release_proof_sha256"]}},
        "artifact_catalog": None, "other_runs_terminal": True,
        "no_live_sidecars": True, "other_run_pins": [],
        "record_sha256": {},
    }
    root = "runs/" + run
    inbox_id = sha(canonical([run, tasks[0]["task_id"], "attempt-a", 1]))
    record_paths = {
        root + "/run_intent.json", root + "/run_catalog.json", root + "/start_release.json",
        "objects/sha256/" + study_ref, "objects/sha256/" + catalog_ref,
        root + "/worker-attempts/" + tasks[0]["task_id"] + "/attempt-a/epoch-1/worker_execution_started.v1.json",
        root + "/worker-attempts/" + tasks[0]["task_id"] + "/attempt-a/epoch-1/worker_prelaunch_failed.v1.json",
        root + "/worker_inbox/" + inbox_id + ".json",
        root + "/worker_process_exit_receipts/worker-process-exit-" + "9" * 64 + ".json",
        root + "/resource_leases/cpu/lease-" + "e" * 32 + ".json",
        root + "/preparation_receipt.json",
        root + "/accepted_stage_preparation_receipts/" + tasks[0]["task_id"] + ".json",
        root + "/task_admissions/" + tasks[0]["task_id"] + "/attempt-a.json",
        root + "/coordinator_journal/command/command-53f033710c8b4292bb503537ba77da4a.json",
        root + "/coordinator_journal/command/command-c562e50912d94cc7823f49bd23a4c694.json",
        root + "/coordinator_journal/command/command-fca490c434674e1fb93a95e47ac5cf28.json",
        root + "/coordinator_journal/event/6881cc15a42a4c9584c560351853bc80.json",
        root + "/coordinator_journal/event/804637cd89a64e83be6a6d3546543d73.json",
        root + "/coordinator_journal/event/d1e3cfa9b7ba495ea1da499fc5c249e9.json",
        root + "/coordinator_journal/event/event-prepared-b3614f8cc54f7b77fe6992e356f292bb7fda73ca8b0ac6e5f05a746b60fa2373.json",
    }
    record_paths.update(root + "/task_preparation_receipts/" + task["task_id"] + ".json" for task in tasks)
    evidence["record_sha256"] = {path: "a" * 64 for path in record_paths}
    return evidence


def preflight():
    api = "11111111-1111-4111-8111-111111111111"
    session = "session-abc"
    run = "run-abc"
    status = {"session": {"session_id": session, "session_epoch": f"{session}@1700000000000",
                          "request_scope_epoch": f"{api}:3", "name": "P22", "script": {}},
              "run": {"run_id": run}, "solver": {"state": "waiting_for_compute"},
              "resources": {"scene_revision": 7, "mesh_revision": 4, "domain_generation_id": "domain-1"}}
    scene = {"revision": 7, "study": {}}
    commands = {"revision": 3, "pending_count": 0, "accepted_count": 0, "dispatched_count": 0,
                "running_count": 0, "completed_count": 0, "rejected_count": 0, "failed_count": 0,
                "commands": []}
    return {"api_instance_id": api, "status": status,
            "run": {"run_id": run, "session_id": session, "status": "waiting_for_compute", "revision": 12,
                    "started_at": "1700000000000"},
            "scene": scene, "queue": {"schema_version": "compute_queue.v1", "revision": "sha256:" + "9" * 64,
                "items": [{"item_id": "queue-b", "project_id": "project-abc", "run_id": run,
                           "task_id": task_id(run, "relax-b"), "accepted_at": "2026-11-07T12:00:00Z",
                           "scheduling_priority": 0, "state": "accepted", "blocking_reason": "dependency",
                           "attempt_id": None, "ownership_epoch": None, "resource_id": None},
                          {"item_id": "queue-c", "project_id": "project-abc", "run_id": run,
                           "task_id": task_id(run, "relax-c"), "accepted_at": "2026-11-07T12:00:00Z",
                           "scheduling_priority": 0, "state": "accepted", "blocking_reason": "dependency",
                           "attempt_id": None, "ownership_epoch": None, "resource_id": None}],
                "next_cursor": None},
            "commands": commands,
            "runtime": {"schema_version": "application_service_status.v1", "configured": True, "state": "ready"},
            "health": {"status": "ok", "active_session": True}}


class PrelaunchFailureStopTests(unittest.TestCase):
    @staticmethod
    def temporary_source_paths(directory):
        root = pathlib.Path(directory)
        names = subject.SOURCE_FILE_NAMES
        paths = {}
        for role, filename in names.items():
            path = root / filename
            path.write_bytes((role + "-source\n").encode())
            paths[role] = path
        return paths

    def test_controller_prelaunch_argument_copy_reaches_legacy_validator(self):
        import docker_volume_dev as controller
        args = types.SimpleNamespace(capture_prelaunch_failure=True, quiesce_api=True)
        with patch.object(subject, "validate_options", return_value=(True, None)), \
             patch("docker_volume_native_terminal_stop.validate_options",
                   side_effect=subject.BuildControlError("reached legacy validator")) as legacy:
            with self.assertRaisesRegex(subject.BuildControlError, "reached legacy validator"):
                controller._retained_operation(args, recreate_services=False,
                                               restart_idle_service=True, stop_after_drain=True)
        copied = legacy.call_args.args[0]
        self.assertIsNot(copied, args)
        self.assertFalse(copied.quiesce_api)
        self.assertTrue(args.quiesce_api)

    def test_source_binding_pins_launcher_controller_and_helper_and_detects_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.temporary_source_paths(directory)
            binding = subject.capture_source_binding(paths)
            self.assertEqual(
                [item["name"] for item in binding["files"]],
                list(subject.SOURCE_FILE_NAMES.values()),
            )
            self.assertEqual(subject.assert_source_binding_current(binding), binding)
            chain = {"prelaunch_failure_source_binding": binding}
            intent = {"source_binding": binding}
            captured = {"source_binding": binding}
            self.assertEqual(subject.validate_source_binding_chain(chain, intent, captured), binding)
            mismatched = copy.deepcopy(intent)
            mismatched["source_binding"]["files"][0]["sha256"] = "f" * 64
            with self.assertRaises(subject.BuildControlError):
                subject.validate_source_binding_chain(chain, mismatched, captured)
            paths["recovery_helper"].write_bytes(b"changed source\n")
            with self.assertRaises(subject.BuildControlError):
                subject.assert_source_binding_current(binding)
            with self.assertRaises(subject.BuildControlError):
                subject.validate_source_binding({"schema": subject.SOURCE_BINDING_SCHEMA, "files": []})

    def embedded_collect_runtime(self, clock):
        tree = ast.parse(subject.LOCKED_PROBE)
        wanted = {"WriterLockBusy", "collect_once", "collect"}
        body = [node for node in tree.body if getattr(node, "name", None) in wanted]
        self.assertEqual({node.name for node in body}, wanted)
        namespace = {"time": clock}
        exec(compile(ast.Module(body=body, type_ignores=[]), "LOCKED_PROBE.collect", "exec"), namespace)
        return namespace

    def test_writer_lock_retry_reacquires_until_a_fresh_pair_is_available(self):
        class Clock:
            now = 0.0
            sleeps = []

            def monotonic(self):
                return self.now

            def sleep(self, seconds):
                self.sleeps.append(seconds)
                self.now += seconds

        clock = Clock()
        namespace = self.embedded_collect_runtime(clock)
        attempts = []

        def collect_once(*args):
            attempts.append(args)
            if len(attempts) < 3:
                raise namespace["WriterLockBusy"]()
            return {"fresh": True}

        namespace["collect_once"] = collect_once
        self.assertEqual(namespace["collect"]({"run_id": "run-1"}, "ready", {"owner": "pinned"}),
                         {"fresh": True})
        self.assertEqual(len(attempts), 3)
        self.assertEqual(attempts[0], attempts[2])
        self.assertEqual(clock.sleeps, [0.05, 0.05])

    def test_writer_lock_retry_deadline_fails_closed(self):
        class Clock:
            now = 0.0

            def monotonic(self):
                return self.now

            def sleep(self, seconds):
                self.now += seconds

        clock = Clock()
        namespace = self.embedded_collect_runtime(clock)
        attempts = []

        def always_busy(*args):
            attempts.append(args)
            raise namespace["WriterLockBusy"]()

        namespace["collect_once"] = always_busy
        with self.assertRaisesRegex(RuntimeError, "bounded writer-lock contention"):
            namespace["collect"]({"run_id": "run-1"})
        self.assertGreater(len(attempts), 1)
        self.assertLessEqual(clock.now, 3.000001)

    def test_contended_lock_descriptors_are_closed_before_retry(self):
        namespace = self.embedded_collect_runtime(types.SimpleNamespace(monotonic=lambda: 0, sleep=lambda _: None))

        class FakeOS:
            O_RDONLY = 0

            def __init__(self):
                self.closed = []

            def close(self, fd):
                self.closed.append(fd)

            def fstat(self, fd):
                return types.SimpleNamespace(st_mode=0, st_nlink=1)

            def read(self, fd, size):
                return b"fullmag.writer.lock.v1\n"

        class FakeFcntl:
            LOCK_EX, LOCK_NB, LOCK_UN = 1, 2, 4

            def __init__(self, busy_call):
                self.busy_call = busy_call
                self.calls = []

            def flock(self, fd, operation):
                self.calls.append((fd, operation))
                if len(self.calls) == self.busy_call:
                    raise BlockingIOError(11, "writer lock held")

        for busy_call, expected_closed in ((1, {11, 12, 13}), (2, {11, 12, 13, 14})):
            with self.subTest(busy_call=busy_call):
                os_stub = FakeOS()
                fcntl_stub = FakeFcntl(busy_call)
                child_calls = []
                namespace.update({
                    "os": os_stub,
                    "fcntl": fcntl_stub,
                    "paths": types.SimpleNamespace(store="/state/store"),
                    "pathlib": pathlib,
                    "open_absolute_dir": lambda path: 11 if str(path) == "/state/store" else 12,
                    "open_child": lambda parent, name: (child_calls.append((parent, name)) or
                                                          (13 if parent == 12 else 14)),
                })
                with self.assertRaises(namespace["WriterLockBusy"]):
                    namespace["collect_once"]({"run_id": "run-1"})
                self.assertEqual(set(os_stub.closed), expected_closed)
                self.assertTrue(all(name == "WRITER.lock" for _, name in child_calls))
                if busy_call == 2:
                    self.assertIn((13, fcntl_stub.LOCK_UN), fcntl_stub.calls)

    def test_cli_exposes_only_paired_stop_and_fresh_archive_flags(self):
        stop = docker_dev._parser().parse_args([
            "--repo-root", "/tmp/fullmag", "restart-idle-volume", "--attempt", "a" * 32,
            "--config-sha256", "b" * 64, "--source-root", "/tmp/source", "--port", "3242",
            "--stop-only", "--quiesce-api", "--capture-prelaunch-failure",
        ])
        self.assertTrue(stop.stop_only and stop.quiesce_api and stop.capture_prelaunch_failure)
        archive = docker_dev._parser().parse_args([
            "--repo-root", "/tmp/fullmag", "recreate-volume", "--attempt", "a" * 32,
            "--config-sha256", "b" * 64, "--source-root", "/tmp/source", "--port", "3242",
            "--fresh-state", "--prelaunch-failure-stop", "c" * 32,
            "--prelaunch-failure-stop-sha256", "d" * 64,
        ])
        self.assertTrue(archive.fresh_state)
        self.assertEqual(archive.prelaunch_failure_stop, "c" * 32)
        recipe = (pathlib.Path(__file__).resolve().parents[1] / "justfile").read_text()
        self.assertIn("docker-dev-stop-prelaunch-failure", recipe)
        self.assertIn("--stop-only --quiesce-api --capture-prelaunch-failure", recipe)
        self.assertIn("docker-dev-recreate-prelaunch-failure", recipe)

    def test_exact_mixed_failed_run_is_captured_without_requiring_absent_shared_start_release(self):
        accepted = subject.validate_store_evidence(fixture())
        self.assertEqual(accepted["failed_task_id"], task_id("run-abc", "relax-a"))
        self.assertEqual(accepted["blocked_task_ids"], [task_id("run-abc", "relax-b"), task_id("run-abc", "relax-c")])
        self.assertEqual(accepted["run_id"], "run-abc")

    def test_run_inventory_preserves_only_bounded_metadata_and_all_nested_ancestors(self):
        evidence = fixture()
        binding = subject.validate_store_evidence(evidence)
        files = set(binding["record_sha256"])
        self.assertEqual(len([path for path in files if "/coordinator_journal/" in path]), 7)
        required_dirs = subject._expected_run_directories("run-abc", files)
        nested = "runs/run-abc/worker-attempts/" + binding["failed_task_id"] + "/" + binding["attempt_id"]
        self.assertIn(nested, required_dirs)
        self.assertIn(nested + "/epoch-1", required_dirs)
        evidence["record_sha256"]["runs/run-abc/worker-attempts/other-task/output.json"] = "b" * 64
        with self.assertRaises(subject.BuildControlError):
            subject.validate_store_evidence(evidence)
        evidence = fixture()
        evidence["record_sha256"]["runs/run-abc/coordinator_journal/command/foreign.json"] = "b" * 64
        with self.assertRaises(subject.BuildControlError):
            subject.validate_store_evidence(evidence)

    def test_actual_disconnected_observation_on_failed_a_is_allowed(self):
        accepted = fixture()
        self.assertEqual(subject.validate_store_evidence(accepted)["run_id"], "run-abc")

    def test_started_claim_allows_only_monotonic_lease_heartbeat_renewal(self):
        evidence = fixture()
        self.assertEqual(subject.validate_store_evidence(evidence)["run_id"], "run-abc")
        evidence = fixture()
        claim = evidence["attempts"][task_id("run-abc", "relax-a")]["files"][
            "worker_execution_started.v1.json"]["identity"]["claim"]
        claim["lease"]["heartbeat_sequence"] = 2
        evidence["attempts"][task_id("run-abc", "relax-a")]["files"][
            "worker_prelaunch_failed.v1.json"]["identity"]["claim"]["lease"]["heartbeat_sequence"] = 2
        with self.assertRaises(subject.BuildControlError):
            subject.validate_store_evidence(evidence)
        evidence = fixture()
        released = evidence["worker_exit_receipts"][0]
        released["lease_heartbeat_sequence"] = 0
        release_proofs = evidence["host_ledger"]["release_proofs"]
        next(iter(release_proofs.values()))["worker_receipt"] = released
        with self.assertRaises(subject.BuildControlError):
            subject.validate_store_evidence(evidence)

    def test_worker_inbox_requires_flat_claim_and_prepare_start_heartbeat_order(self):
        self.assertEqual(subject.validate_store_evidence(fixture())["run_id"], "run-abc")
        mutations = (
            lambda payload: payload["claim"].update(task_id="foreign-task"),
            lambda payload: payload["applied"].__setitem__(2, {
                **copy.deepcopy(payload["applied"][1]), "sequence": 3, "message_id": "duplicate-start"}),
            lambda payload: payload["applied"].reverse(),
            lambda payload: payload.update(pending={"unexpected": True}),
            lambda payload: payload["applied"][2]["claim"].update(attempt_id="foreign-attempt"),
            lambda payload: payload["applied"][2].update(schema_version="worker_protocol.v5"),
            lambda payload: payload["applied"][2]["command"].update(kind="stop", reason="operator"),
        )
        for mutation in mutations:
            evidence = fixture()
            inbox = evidence["attempts"][task_id("run-abc", "relax-a")]["worker_inbox"]
            mutation(inbox["payload"])
            inbox["payload_sha256"] = sha(canonical(inbox["payload"]))
            with self.subTest(mutation=mutation), self.assertRaises(subject.BuildControlError):
                subject.validate_store_evidence(evidence)

    def test_rejects_worker_no_spawn_or_mismatched_exit_release(self):
        evidence = fixture()
        evidence["host_ledger"]["release_proofs"][evidence["host_ledger"]["reservations"][0]["release_proof_sha256"]]["kind"] = "worker_no_spawn"
        with self.assertRaises(subject.BuildControlError):
            subject.validate_store_evidence(evidence)

    def test_rejects_active_a_lease_and_b_or_c_claim(self):
        evidence = fixture()
        evidence["leases"][0]["state"] = "active"
        with self.assertRaises(subject.BuildControlError):
            subject.validate_store_evidence(evidence)
        evidence = fixture()
        evidence["run_catalog"]["tasks"][1]["attempt_id"] = "attempt-b"
        with self.assertRaises(subject.BuildControlError):
            subject.validate_store_evidence(evidence)

    def test_rejects_artifact_sidecar_unknown_task_or_unrelated_active_run(self):
        for edit in (
            lambda value: value.update(artifact_catalog={"entries": [{"artifact_id": "x"}]}),
            lambda value: value.update(no_live_sidecars=False),
            lambda value: value["run_catalog"]["tasks"].append(copy.deepcopy(value["run_catalog"]["tasks"][0])),
            lambda value: value.update(other_runs_terminal=False),
        ):
            evidence = fixture()
            edit(evidence)
            with self.subTest(edit=edit), self.assertRaises(subject.BuildControlError):
                subject.validate_store_evidence(evidence)

    def test_api_snapshot_requires_exact_waiting_run_idle_commands_ready_owner(self):
        self.assertEqual(subject.snapshot_binding(preflight())["run_id"], "run-abc")
        for edit in (
            lambda value: value["run"].update(status="completed"),
            lambda value: value["commands"].update(running_count=1),
            lambda value: value["commands"]["commands"].append({"kind": "solve", "status": "completed"}),
            lambda value: value["health"].update(active_session=False),
        ):
            snapshot = preflight()
            edit(snapshot)
            with self.subTest(edit=edit), self.assertRaises(subject.BuildControlError):
                subject.snapshot_binding(snapshot)

    def test_api_snapshot_binding_ignores_telemetry_but_rejects_authority_drift(self):
        before = subject.snapshot_binding(preflight())
        uptime_only = preflight()
        uptime_only["status"]["metrics"] = {"uptime_seconds": 10}
        self.assertEqual(before, subject.snapshot_binding(uptime_only))
        for edit in (
            lambda value: value["scene"].update(revision=8),
            lambda value: value["run"].update(run_id="run-other"),
            lambda value: value["queue"].update(revision="sha256:" + "8" * 64),
            lambda value: value["commands"].update(revision=4),
        ):
            after = preflight()
            edit(after)
            with self.subTest(edit=edit):
                try:
                    self.assertNotEqual(before, subject.snapshot_binding(after))
                except subject.BuildControlError:
                    pass

    def test_capture_options_are_stop_only_and_quiesce_api_is_mandatory(self):
        valid = types.SimpleNamespace(capture_prelaunch_failure=True, quiesce_api=True,
            capture_native_terminal=False, capture_terminal_observation=False,
            saved_authoring_checkpoint=None, saved_authoring_checkpoint_sha256=None,
            allow_prepared_session=False, prelaunch_failure_stop=None,
            prelaunch_failure_stop_sha256=None, fresh_state=False, script=None)
        self.assertTrue(subject.validate_options(valid, recreate_services=False, restart_idle_service=True,
            stop_after_drain=True)[0])
        valid.quiesce_api = False
        with self.assertRaises(subject.BuildControlError):
            subject.validate_options(valid, recreate_services=False, restart_idle_service=True, stop_after_drain=True)

    def test_fresh_state_requires_paired_exact_stop_receipt_and_excludes_restore_modes(self):
        args = types.SimpleNamespace(prelaunch_failure_stop="a" * 32,
            prelaunch_failure_stop_sha256="b" * 64, fresh_state=True, script=None,
            recovery_authorization=None, native_terminal_stop=None, native_terminal_stop_sha256=None,
            terminal_observation_stop=None, terminal_observation_proof=None,
            terminal_observation_proof_sha256=None, empty_api_abort_stop=None,
            empty_api_abort_stop_sha256=None, completed_recreation_attempt=None,
            completed_recreation_sha256=None, drained_successor_proof=None,
            drained_successor_proof_sha256=None, offline_reconciliation=None,
            restart_backend=False, pending_activation=False)
        self.assertEqual(subject.fresh_pin(args, recreate_services=True), ("a" * 32, "b" * 64))
        args.fresh_state = False
        with self.assertRaises(subject.BuildControlError):
            subject.fresh_pin(args, recreate_services=True)
        args.fresh_state = True
        args.attempt = "a" * 32
        with self.assertRaises(subject.BuildControlError):
            subject.fresh_pin(args, recreate_services=True)
        args.attempt = "e" * 32
        args.completed_recreation_attempt = "f" * 32
        with self.assertRaises(subject.BuildControlError):
            subject.fresh_pin(args, recreate_services=True)

    def test_quiesce_transport_validates_embedded_response_without_running_probe(self):
        evidence = fixture()
        snapshot = preflight()
        preflight_pin = subject.snapshot_binding(snapshot)
        store_binding = subject.validate_store_evidence(evidence)
        owner = {key: key for key in (
            "owner_token", "process_start_token", "host", "target_id", "protocol", "build_commit",
            "build_snapshot", "control_address", "compute_pool_generation", "preparation_pool_generation",
            "compute_pool_id", "preparation_pool_id",
        )}
        owner.update(pid=12, state="ready", children=[
            {"role": "compute", "pid": 13, "status": "running"},
            {"role": "preparation", "pid": 14, "status": "running"},
        ])
        owner_sha = sha(canonical(subject._identity(owner)))
        api_pin = {"pid": 42, "start_token": "123", "ppid": 20,
                   "argv": ["/opt/fullmag/package/bin/fullmag-api"],
                   "exe": "/opt/fullmag/package/bin/fullmag-api"}
        prepared = {
            "preflight": preflight_pin,
            "store_binding": store_binding,
            "locked_evidence_sha256": subject._locked_store_evidence_sha(evidence),
            "store_binding_sha256": subject._store_binding_hash(store_binding),
            "ready_owner_sha256": owner_sha,
            "native_config_sha256": "a" * 64,
            "process_sha256": "b" * 64,
            "api_pin": api_pin,
        }
        api_quiescence = {
            "schema": subject.QUIESCE_SCHEMA,
            "api_instance_id": preflight_pin["api_instance_id"],
            "api_pin": api_pin,
            "api_closed": True,
            "signal": "SIGTERM",
            "api_exit_code": -15,
            "api_diagnostic_only": False,
            "error": subject.QUIESCE_CAUSE,
            "preflight_sha256": sha(canonical(preflight_pin)),
            "store_binding_sha256": subject._store_binding_hash(store_binding),
            "locked_evidence_sha256": prepared["locked_evidence_sha256"],
            "ready_owner_sha256": owner_sha,
            "intent_sha256": "c" * 64,
            "failure_process_sha256": "d" * 64,
        }
        response = {"preflight": snapshot, "store_evidence": evidence,
                    "api_quiescence": api_quiescence}
        source_binding = subject.capture_source_binding({
            "launcher": pathlib.Path(docker_dev.__file__),
            "controller": pathlib.Path(subject.__file__).with_name("docker_volume_dev.py"),
            "recovery_helper": pathlib.Path(subject.__file__),
        })
        intent = {"schema": subject.QUIESCE_INTENT_SCHEMA, "prepared": prepared,
                  "source_binding": source_binding}
        fake = types.SimpleNamespace(stdout=json.dumps(response, sort_keys=True).encode())
        self.assertIn("entrypoint._configure_device_access()", subject.LOCKED_PROBE)
        self.assertIn("service._service_status(paths)", subject.LOCKED_PROBE)
        locked_collect = subject.LOCKED_PROBE.split("def collect(", 1)[1].split("def store_evidence_sha(", 1)[0]
        self.assertNotIn("_service_status", locked_collect)
        prepare_probe = subject.LOCKED_PROBE.split("def prepare():", 1)[1].split("def quiesce():", 1)[0]
        self.assertIn("os.pidfd_open(api[\"pid\"])", prepare_probe)
        self.assertNotIn("signal.pidfd_send_signal(", prepare_probe)
        with patch.object(subject, "docker_capture", return_value=fake) as transport:
            captured = subject.quiesce_api_and_capture("backend-container", intent)
        transport.assert_called_once()
        argv = transport.call_args.args
        self.assertEqual(argv[:2], ("exec", "backend-container"))
        self.assertEqual(argv[7], "quiesce")
        self.assertEqual(captured["store_binding"], store_binding)
        self.assertEqual(captured["api_quiescence"]["api_pin"], api_pin)
        self.assertEqual(captured["source_binding"], source_binding)

    def test_quiesce_transport_fails_unknown_if_source_changes_during_api_close(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.temporary_source_paths(directory)
            source_binding = subject.capture_source_binding(paths)
            intent = {"schema": subject.QUIESCE_INTENT_SCHEMA, "prepared": {},
                      "source_binding": source_binding}
            fake = types.SimpleNamespace(stdout=b"{}")

            def close_api_then_change_source(*args, **kwargs):
                paths["controller"].write_bytes(b"changed after api closure\n")
                return fake

            with patch.object(subject, "docker_capture", side_effect=close_api_then_change_source):
                with self.assertRaises(subject.BuildControlError):
                    subject.quiesce_api_and_capture("backend-container", intent)

    def test_postdrain_transport_rechecks_locked_store_without_running_helper(self):
        evidence = fixture()
        store_binding = subject.validate_store_evidence(evidence)
        response = {"schema": "fullmag.prelaunch-failure-locked-evidence.v1",
                    "store_evidence": evidence}
        fake = types.SimpleNamespace(stdout=json.dumps(response, sort_keys=True).encode())
        with patch.object(subject, "docker_capture", return_value=fake) as transport:
            proof = subject.verify_stopped_locked("a" * 64, "sha256:" + "b" * 64,
                                                  "run-abc", store_binding["store_id"], store_binding)
        argv = transport.call_args.args
        self.assertEqual(argv[:4], ("run", "--rm", "--pull", "never"))
        self.assertIn("none", argv)
        self.assertIn("runc", argv)
        self.assertIn("--read-only", argv)
        self.assertIn("ALL", argv)
        self.assertIn("128m", argv)
        self.assertIn("16", argv)
        self.assertIn("65532:65532", argv)
        self.assertIn("a" * 64 + ":ro", argv)
        self.assertEqual(argv[-3], "offline")
        self.assertEqual(proof["schema"], subject.POSTDRAIN_SCHEMA)
        self.assertEqual(proof["store_binding_sha256"], subject._store_binding_hash(store_binding))
        bad = dict(store_binding, host_id="different-host")
        with patch.object(subject, "docker_capture", return_value=fake):
            with self.assertRaises(subject.BuildControlError):
                subject.verify_stopped_locked("a" * 64, "sha256:" + "b" * 64,
                                              "run-abc", store_binding["store_id"], bad)

    def test_rejects_foreign_api_or_owner_incarnation_and_non_drained_receipt(self):
        owner = {key: key for key in ("owner_token", "process_start_token", "host", "target_id", "protocol",
                 "build_commit", "build_snapshot", "control_address", "compute_pool_generation",
                 "preparation_pool_generation", "compute_pool_id", "preparation_pool_id")}
        owner.update(pid=12, state="ready", children=[{"role": "compute", "pid": 13, "status": "running"},
                      {"role": "preparation", "pid": 14, "status": "running"}])
        before = subject.snapshot_binding(preflight())
        evidence = fixture()
        store = subject.validate_store_evidence(evidence)
        api_pin = {"pid": 42, "start_token": "123", "ppid": 20,
                   "argv": ["/opt/fullmag/package/bin/fullmag-api"],
                   "exe": "/opt/fullmag/package/bin/fullmag-api"}
        quiescence = {"schema": subject.QUIESCE_SCHEMA, "api_instance_id": before["api_instance_id"],
                      "api_pin": api_pin, "api_closed": True, "signal": "SIGTERM", "api_exit_code": -15,
                      "api_diagnostic_only": False, "error": subject.QUIESCE_CAUSE,
                      "preflight_sha256": sha(canonical(before)),
                      "store_binding_sha256": sha(canonical(store)),
                      "locked_evidence_sha256": subject._locked_store_evidence_sha(evidence),
                      "ready_owner_sha256": sha(canonical(subject._identity(owner))),
                      "failure_process_sha256": "c" * 64}
        source_binding = subject.capture_source_binding({
            "launcher": pathlib.Path(docker_dev.__file__),
            "controller": pathlib.Path(subject.__file__).with_name("docker_volume_dev.py"),
            "recovery_helper": pathlib.Path(subject.__file__),
        })
        captured = {"schema": subject.SCHEMA, "source_binding": source_binding,
                    "preflight": before, "store_binding": store,
                    "ready_owner_sha256": subject._identity(owner) and sha(canonical(subject._identity(owner))),
                    "locked_evidence_sha256": subject._locked_store_evidence_sha(evidence),
                    "native_config_sha256": "a" * 64,
                    "process_sha256": "b" * 64, "api_pin": api_pin, "api_quiescence": quiescence}
        drained = {"schema": "fullmag.docker-process-tree.v1", "state": "drained",
                   "api_pid": 42, "api_exit_code": -15, "api_diagnostic_only": False,
                   "accepted_store": "/state/runs/docker-all/session-store",
                   "error": "Fullmag API exited unexpectedly (-15)",
                   "service_owner": owner,
                   "terminal_service_owner": {**copy.deepcopy(owner), "state": "drained", "children": [
                       {"role": "compute", "pid": 13, "status": "exited_success"},
                       {"role": "preparation", "pid": 14, "status": "exited_success"}]}}
        subject.validate_drain(captured, drained)
        for field, value in (("api_pid", 43), ("state", "shutdown_unknown")):
            bad = copy.deepcopy(drained)
            bad[field] = value
            with self.subTest(field=field), self.assertRaises(subject.BuildControlError):
                subject.validate_drain(captured, bad)
        bad = copy.deepcopy(drained)
        bad["terminal_service_owner"]["pid"] = 99
        with self.assertRaises(subject.BuildControlError):
            subject.validate_drain(captured, bad)


    def test_fresh_archive_validates_receipts_current_sources_and_offline_records(self):
        with tempfile.TemporaryDirectory() as directory:
            self._check_fresh_archive(pathlib.Path(directory))

    def _check_fresh_archive(self, source_dir):
        owner = {key: key for key in ("owner_token", "process_start_token", "host", "target_id", "protocol",
                 "build_commit", "build_snapshot", "control_address", "compute_pool_generation",
                 "preparation_pool_generation", "compute_pool_id", "preparation_pool_id")}
        owner.update(pid=12, state="ready", children=[{"role": "compute", "pid": 13, "status": "running"},
                      {"role": "preparation", "pid": 14, "status": "running"}])
        before = subject.snapshot_binding(preflight())
        evidence = fixture()
        store = subject.validate_store_evidence(evidence)
        api_pin = {"pid": 42, "start_token": "123", "ppid": 20,
                   "argv": ["/opt/fullmag/package/bin/fullmag-api"],
                   "exe": "/opt/fullmag/package/bin/fullmag-api"}
        quiescence = {"schema": subject.QUIESCE_SCHEMA, "api_instance_id": before["api_instance_id"],
                      "api_pin": api_pin, "api_closed": True, "signal": "SIGTERM", "api_exit_code": -15,
                      "api_diagnostic_only": False, "error": subject.QUIESCE_CAUSE,
                      "preflight_sha256": sha(canonical(before)),
                      "store_binding_sha256": sha(canonical(store)),
                      "locked_evidence_sha256": subject._locked_store_evidence_sha(evidence),
                      "ready_owner_sha256": sha(canonical(subject._identity(owner))),
                      "failure_process_sha256": "c" * 64}
        source_paths = {}
        for role, name in subject.SOURCE_FILE_NAMES.items():
            path = source_dir / name
            path.write_text("# pinned source\n")
            source_paths[role] = path
        source_binding = subject.capture_source_binding(source_paths)
        captured = {"schema": subject.SCHEMA, "source_binding": source_binding,
                    "preflight": before, "store_binding": store,
                    "ready_owner_sha256": subject._identity(owner) and sha(canonical(subject._identity(owner))),
                    "locked_evidence_sha256": subject._locked_store_evidence_sha(evidence),
                    "native_config_sha256": "a" * 64,
                    "process_sha256": "b" * 64, "api_pin": api_pin, "api_quiescence": quiescence}
        drained = {"schema": "fullmag.docker-process-tree.v1", "state": "drained",
                   "api_pid": 42, "api_exit_code": -15, "api_diagnostic_only": False,
                   "accepted_store": "/state/runs/docker-all/session-store",
                   "error": "Fullmag API exited unexpectedly (-15)",
                   "service_owner": owner,
                   "terminal_service_owner": {**copy.deepcopy(owner), "state": "drained", "children": [
                       {"role": "compute", "pid": 13, "status": "exited_success"},
                       {"role": "preparation", "pid": 14, "status": "exited_success"}]}}

        stop_attempt = "d" * 32
        base = "iteration/attempts/" + stop_attempt + "/"
        control = types.SimpleNamespace(project="project", volume="volume", namespace="", namespace_registry_sha256=None)
        actual = {name: {"Id": digit * 64, "Image": "sha256:" + "a" * 64,
                         "Config": {}, "HostConfig": {}, "Mounts": [],
                         "State": {"StartedAt": "fixed", "Running": False,
                                   "ExitCode": 1 if name == "backend" else 0, "OOMKilled": False}}
                  for name, digit in (("backend", "1"), ("frontend", "2"))}
        intent = {"schema": subject.QUIESCE_INTENT_SCHEMA, "source_binding": source_binding}
        postdrain = {"schema": subject.POSTDRAIN_SCHEMA, "run_id": store["run_id"],
                     "store_id": store["store_id"], "store_binding_sha256": subject._store_binding_hash(store),
                     "locked_evidence_sha256": captured["locked_evidence_sha256"]}
        config_raw = b"native config"
        captured["native_config_sha256"] = sha(config_raw)
        encode = lambda value: canonical(value) + b"\n"
        records = {
            base + "prelaunch-failure-quiescence-intent.json": encode(intent),
            base + "prelaunch-failure-stop.json": encode(captured),
            base + "backend-drain.json": encode({"schema": "fullmag.docker-idle-restart-drain.v1",
                "backend_container_id": actual["backend"]["Id"], "process_receipt": drained,
                "process_receipt_sha256": sha(encode(drained))}),
            base + "prelaunch-failure-postdrain-lock.json": encode(postdrain),
            base + "idle-stop-containers.json": encode(actual),
            subject.CONFIG_PATH: config_raw,
            subject.PROCESS_PATH: encode(drained),
        }
        terminal = {"schema": "fullmag.docker-build-operation.v1", "attempt": stop_attempt,
                    "phase": "iteration", "state": "succeeded", "idle_backend_stopped": True,
                    "compose_project": control.project, "control_volume": control.volume,
                    "config_sha256": "e" * 64,
                    "backend_container": actual["backend"]["Id"], "frontend_container": actual["frontend"]["Id"],
                    "inputs": {"source_root": str(source_dir), "attempt": "f" * 32,
                               "capture_prelaunch_failure": True, "quiesce_api": True,
                               "prelaunch_failure_source_binding": source_binding},
                    "api_quiescence_intent_sha256": sha(records[base + "prelaunch-failure-quiescence-intent.json"]),
                    "prelaunch_failure_capture_sha256": sha(records[base + "prelaunch-failure-stop.json"]),
                    "prelaunch_failure_postdrain_sha256": sha(records[base + "prelaunch-failure-postdrain-lock.json"]),
                    "idle_stop_containers_sha256": sha(records[base + "idle-stop-containers.json"])}
        terminal_raw = encode(terminal)
        records[base + "terminal.json"] = terminal_raw
        records[base + "receipt.json"] = terminal_raw
        kwargs = dict(stop_attempt=stop_attempt, stop_sha256=sha(terminal_raw), source_root=str(source_dir),
                      attempt="f" * 32, config_sha256="e" * 64, actual=actual, store_root=source_dir)
        def read(_control, relative, **_kwargs):
            return records[relative]
        with patch("docker_volume_accepted_reattach._control_bytes", side_effect=read), \
             patch.object(subject, "verify_stopped_locked", return_value=postdrain) as offline:
            result = subject.validate_fresh(control, **kwargs)
            self.assertEqual(result["stop_sha256"], sha(terminal_raw))
            offline.assert_called_once()
            with self.assertRaises(subject.BuildControlError):
                subject.validate_fresh(control, **dict(kwargs, stop_sha256="0" * 64))
            source_paths["launcher"].write_text("# changed source\n")
            with self.assertRaisesRegex(subject.BuildControlError, "pinned controller source changed"):
                subject.validate_fresh(control, **kwargs)
            source_paths["launcher"].write_text("# pinned source\n")
            for relative in (subject.CONFIG_PATH, subject.PROCESS_PATH,
                             base + "prelaunch-failure-postdrain-lock.json"):
                old = records[relative]
                records[relative] = b"{}\n"
                with self.subTest(record=relative), self.assertRaises(subject.BuildControlError):
                    subject.validate_fresh(control, **kwargs)
                records[relative] = old
            changed = copy.deepcopy(actual)
            changed["backend"]["Id"] = "9" * 64
            with self.assertRaises(subject.BuildControlError):
                subject.validate_fresh(control, **dict(kwargs, actual=changed))
            offline.return_value = dict(postdrain, store_id="sha256:" + "0" * 64)
            with self.assertRaises(subject.BuildControlError):
                subject.validate_fresh(control, **kwargs)


if __name__ == "__main__":
    unittest.main()
