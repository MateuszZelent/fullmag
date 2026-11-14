"""Mock-only diagnostics for held UI start-retry observation."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import docker_volume_held_ui_retry_probe as subject


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = canonical(value) + b"\n"
    path.write_bytes(raw)
    return raw


class RetryProbeProgramTests(unittest.TestCase):
    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in (
            "FULLMAG_RUNTIME_IMAGE_ID", "FULLMAG_RUNTIME_PROVENANCE")}
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = self.root / "runtime-control"
        self.control = self.root / "control"
        self.state = self.root / "state"
        self.ledger = self.root / "ledger"
        self.proc = self.root / "proc"
        self.host_identity = self.root / "linux-native-host.json"
        self.run_id = "run-live-test"
        self.api_id = "f" * 8 + "-1111-4222-8333-" + "a" * 12
        self.old_api_id = "e" * 8 + "-1111-4222-8333-" + "a" * 12
        self.launch_id = "d" * 8 + "-1111-4222-8333-" + "a" * 12
        self.request = self._make_request()
        self.expected = self._populate()

    def tearDown(self):
        self.temp.cleanup()
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _reset(self):
        self.tearDown()
        self.setUp()

    def _make_request(self):
        maintenance_id = "c" * 8 + "-1111-4222-8333-" + "a" * 12
        request_root = "held-ui-materialization/" + maintenance_id
        accepted = {
            "project_id": "project-test", "run_id": self.run_id,
            "session_id": "session-test", "session_epoch": 1,
            "session_created_at_unix_ms": 1794582150656,
            "old_api_instance_id": self.old_api_id,
            "old_request_scope_epoch": self.old_api_id + ":1",
            "scene_revision": 2, "run_intent_sha256": "0" * 64,
            "run_intent_payload_sha256": "0" * 64,
            "definition_sha256": "0" * 64, "study_sha256": "0" * 64,
            "accepted_scene_sha256": "0" * 64,
            "execution_input_sha256": "0" * 64,
            "command_id": "fm-11111111-1111-4111-8111-111111111111",
            "command_kind": "relax", "client_intent_id": "study:relax:test",
            "request_id": "11111111-1111-4111-8111-111111111111",
            "request_sha256": "0" * 64, "request_key_sha256": "0" * 64,
            "request_receipt_sha256": "0" * 64,
        }
        source_scope = {
            "compose_project": "fullmag-test", "control_volume": "fullmag-test-control",
            "namespace": "", "namespace_registry_sha256": None,
            "source_root": "/selected/source", "state_root_sha256": "1" * 64,
            "backend_container_id": "2" * 64, "backend_started_at": "2026-11-14T00:00:00Z",
            "frontend_container_id": "3" * 64, "frontend_started_at": "2026-11-14T00:00:01Z",
            "runtime_config_sha256": "4" * 64,
        }
        names = {"preflight": "preflight.json", "inventory": "inventory.json",
                 "api_quiescence": "api-quiescence.json", "native_drain": "native-drain.json"}
        stop_attempt = "b" * 32
        return {
            "schema": "fullmag.held-ui-materialization-request.v1",
            "plan": {"attempt": "a" * 32, "plan_sha256": "5" * 64,
                     "maintenance_request_id": maintenance_id},
            "source_scope": source_scope,
            "accepted": accepted,
            "stop_authority": {
                "stop_attempt": stop_attempt,
                "terminal": {"path": "held-ui-materialization-stop/attempts/" + stop_attempt + "/terminal.json",
                             "sha256": "6" * 64},
                **{key: {"path": request_root + "/" + leaf, "sha256": "7" * 64}
                   for key, leaf in names.items()},
            },
        }

    def _populate(self):
        accepted = self.request["accepted"]
        definition = b"definition-cas"
        study = b"study-cas"
        definition_sha = digest(definition)
        study_sha = digest(study)
        accepted["definition_sha256"] = definition_sha
        accepted["study_sha256"] = study_sha
        command = {"command_id": accepted["command_id"], "kind": "relax",
                   "client_intent_id": accepted["client_intent_id"]}
        receipt = {"request_id": accepted["request_id"],
                   "request_sha256": accepted["request_sha256"],
                   "key_sha256": accepted["request_key_sha256"],
                   "command_id": accepted["command_id"], "command_kind": "relax",
                   "client_intent_id": accepted["client_intent_id"]}
        execution = {"schema_version": "fullmag.scene_execution_input.v1",
                     "sha256": accepted["execution_input_sha256"]}
        live = {"api_instance_id": accepted["old_api_instance_id"],
                "session_id": accepted["session_id"], "session_epoch": 1,
                "scene_revision": accepted["scene_revision"], "command": command,
                "request_receipt": receipt, "execution_input": execution}
        spec = {"run_id": accepted["run_id"], "snapshot": {
                    "project_id": accepted["project_id"],
                    "definition_sha256": definition_sha},
                "study": {"plan_sha256": study_sha},
                "parameters": {"live_workspace": live}}
        intent = {"schema_version": "run_intent.v1", "run_id": accepted["run_id"],
                  "specification": spec, "payload_sha256": digest(canonical(spec)),
                  "definition_object_ref": definition_sha, "study_object_ref": study_sha}
        store = self.state / "runs" / "docker-all" / "session-store"
        run_dir = store / "runs" / self.run_id
        intent_raw = write_json(run_dir / "run_intent.json", intent)
        demand_raw = write_json(run_dir / "live_demand.v1.json", {
            "schema_version": "fullmag.accepted_live_demand.v1", "run_id": self.run_id,
            "quantities": ["m"]})
        accepted["run_intent_sha256"] = digest(intent_raw)
        accepted["run_intent_payload_sha256"] = intent["payload_sha256"]
        accepted["request_receipt_sha256"] = digest(canonical(receipt))
        object_root = store / "objects" / "sha256"
        object_root.mkdir(parents=True)
        (object_root / definition_sha).write_bytes(definition)
        (object_root / study_sha).write_bytes(study)

        owner = {"schema": "fullmag.linux-native-host.v1", "engine_id": "engine-test",
                 "owner_token": "8" * 32, "storage_profile": "linux-native-v1",
                 "role": "session", "owner_scope": "docker-linux", "restart_verified": True}
        store_id = "sha256:" + digest(canonical({
            "schema": "fullmag.linux-native-store-identity.v1", "engine_id": owner["engine_id"],
            "owner_token": owner["owner_token"], "relative_state_path": "runs/docker-all/session-store"}))
        write_json(self.host_identity, owner)
        write_json(self.state / ".fullmag-linux-native-owner.json", owner)
        (store / "WRITER.lock").parent.mkdir(parents=True, exist_ok=True)
        (store / "WRITER.lock").write_bytes(b"")
        (store / "runtime-services" / "OWNER.lock").parent.mkdir(parents=True)
        lock_paths = {
            "owner": store / "runtime-services" / "OWNER.lock",
            "startup_gate": store / "runtime-services" / "STARTUP-GATE.lock",
            "launch": store / "runtime-services" / "LAUNCH.lock",
            "host_inventory_owner": self.ledger / "HOST_INVENTORY_OWNER.lock",
        }
        for path in lock_paths.values():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"")
        (self.ledger / "WRITER.lock").write_bytes(b"")
        host_request_sha = "9" * 64
        host_identity = {"store_id": store_id, "resource": "gpu"}
        release_proof = {
            "schema_version": "host_resource_release_proof.v2",
            "host_id": "host-test", "store_id": store_id,
            "request_sha256": host_request_sha,
        }
        release_proof_raw = canonical(release_proof) + b"\n"
        release_proof_sha = digest(release_proof_raw)
        proof_dir = self.ledger / "proofs"
        proof_dir.mkdir(parents=True, exist_ok=True)
        (proof_dir / (release_proof_sha + ".json")).write_bytes(release_proof_raw)
        write_json(self.ledger / "HOST_RESOURCE_LEDGER.json", {
            "schema_version": "host_resource_ledger.v4",
            "policy": {"host_id": "host-test"},
            "reservations": [{"state": "released", "identity": host_identity,
                              "request_sha256": host_request_sha,
                              "release_proof_sha256": release_proof_sha}],
        })
        historical_run = store / "runs" / "run-historical"
        write_json(historical_run / "run_catalog.json", {
            "schema_version": "run_catalog.v1", "run_id": "run-historical",
            "tasks": [{"lifecycle": "succeeded"}],
        })
        write_json(historical_run / "resource_leases" / "gpu" / "lease.json", {"state": "released"})

        native_config = {"schema_version": "runtime_service_config.v2",
                         "store_root": "/state/runs/docker-all/session-store"}
        native_config_raw = write_json(self.runtime / "runtime-service" / "docker-all.json", native_config)
        image_id = "sha256:" + "1" * 64
        provenance = {"schema": "fullmag.docker-all-image.v1", "state": "succeeded",
                      "commit": "a" * 40, "source_snapshot_sha256": "2" * 64,
                      "image_id": image_id}
        write_json(self.control / "backend" / "runtime-provenance.json", provenance)
        os.environ["FULLMAG_RUNTIME_IMAGE_ID"] = image_id
        os.environ["FULLMAG_RUNTIME_PROVENANCE"] = "/opt/fullmag/control/backend/runtime-provenance.json"
        target = {"build_id": provenance["commit"], "source_sha256": provenance["source_snapshot_sha256"],
                  "image_id": image_id,
                  "config_sha256": digest(native_config_raw),
                  "accepted_store_binding": subject.accepted_store_binding("/state/runs/docker-all/session-store")}
        store_snapshot = {
            "run_id": self.run_id, "store_id": store_id,
            "run_intent_sha256": accepted["run_intent_sha256"],
            "run_intent_payload_sha256": accepted["run_intent_payload_sha256"],
            "definition_sha256": definition_sha, "study_sha256": study_sha,
            "execution_input": execution,
            "run_files": [{"name": "live_demand.v1.json", "sha256": digest(demand_raw)},
                          {"name": "run_intent.json", "sha256": digest(intent_raw)}],
            "run_catalog_absent": True, "start_release_absent": True,
            "pending_materialization": True, "task_attempts": [], "leases": [],
            "workers": [], "outputs": [], "other_active_runs": [],
        }

        parent = self.request["plan"]["maintenance_request_id"]
        request_dir = self.runtime / "held-ui-materialization" / parent
        prior_native_config = canonical({"schema_version": "runtime_service_config.v2",
                                         "store_root": "/prior/native/store"}) + b"\n"
        preflight = {"schema": "fullmag.held-ui-materialization-preflight.v1",
                     "source_scope": self.request["source_scope"],
                     "native_config_sha256": digest(prior_native_config),
                     "accepted_store_binding": target["accepted_store_binding"],
                     "run_intent_sha256": accepted["run_intent_sha256"],
                     "execution_input_sha256": accepted["execution_input_sha256"]}
        inventory = {"schema": "fullmag.held-ui-materialization-inventory.v1",
                     "before": store_snapshot, "after": store_snapshot}
        proof_values = {"preflight.json": preflight, "inventory.json": inventory,
                        "api-quiescence.json": {"fixture": "api-quiescence"},
                        "native-drain.json": {"fixture": "native-drain"}}
        proof_raws = {name: write_json(request_dir / name, value)
                      for name, value in proof_values.items()}
        if digest(prior_native_config) == digest(native_config_raw):
            raise AssertionError("old and target native config pins must stay distinct")
        for key, name in (("preflight", "preflight.json"), ("inventory", "inventory.json"),
                          ("api_quiescence", "api-quiescence.json"), ("native_drain", "native-drain.json")):
            self.request["stop_authority"][key]["sha256"] = digest(proof_raws[name])
        terminal_path = (self.control / "held-ui-materialization-stop" / "attempts"
                         / self.request["stop_authority"]["stop_attempt"] / "terminal.json")
        terminal_raw = write_json(terminal_path, {"state": "succeeded", "fixture": "outer-stop"})
        self.request["stop_authority"]["terminal"]["sha256"] = digest(terminal_raw)
        request_raw = write_json(request_dir / "request.json", self.request)
        launch_input = {**self.request,
                        "schema": "fullmag.development-held-ui-materialization-restore.v1",
                        "launch_id": self.launch_id, "target_runtime": target}
        launch_raw = write_json(request_dir / "launch.json", {
            "schema": "fullmag.held-ui-materialization-launch.v1", "launch_id": self.launch_id,
            "request_path": "held-ui-materialization/" + parent + "/request.json",
            "request_sha256": digest(request_raw),
            "input_sha256": digest(canonical(launch_input) + b"\n"), "input": launch_input})

        api_pid = 321
        fence_name = "api-failure-" + ("4" * 32) + ".json"
        fence_rel = "runtime-service/" + fence_name
        failure_fence = {"schema": "fullmag.api-runtime-failure-fence.v1",
                         "stage": "runtime_startup", "api_pid": api_pid,
                         "api_instance_id": self.api_id,
                         "reason": "native startup failed before execution"}
        failure_raw = write_json(self.runtime / fence_rel, failure_fence)
        process = {"schema": "fullmag.docker-process-tree.v1", "state": "failed_outcome_retained",
                   "api_pid": api_pid, "accepted_store": "/state/runs/docker-all/session-store",
                   "api_diagnostic_only": True,
                   "bootstrap": {"schema": "fullmag.docker-accepted-store-bootstrap.v1",
                                 "store_root": "/state/runs/docker-all/session-store",
                                 "binding": target["accepted_store_binding"]},
                   "api_instance_id": self.api_id,
                   "api_failure_fence": "/opt/fullmag/runtime-control/" + fence_rel,
                   "error": failure_fence["reason"]}
        process_raw = write_json(self.runtime / "runtime-service" / "process-tree.json", process)
        self._make_proc_fixture(api_pid, fence_rel)
        return {"target": target, "process_sha256": digest(process_raw),
                "launch_sha256": digest(launch_raw),
                "input_sha256": digest(canonical(launch_input) + b"\n"),
                "native_config_sha256": digest(native_config_raw),
                "failure_fence_sha256": digest(failure_raw),
                "failure_fence_relative": "runtime-control/" + fence_rel,
                "store_snapshot": store_snapshot, "store_id": store_id,
                "lock_paths": lock_paths}

    def _make_proc_fixture(self, pid, fence_relative):
        process = self.proc / str(pid)
        process.mkdir(parents=True)
        (process / "stat").write_text(f"{pid} (fullmag-api) S 1 " + "0 " * 17 + "123456 0\n")
        binary = "/opt/fullmag/package/bin/fullmag-api"
        (process / "cmdline").write_bytes(binary.encode() + b"\0")
        (process / "exe").symlink_to(binary)
        (process / "ns").mkdir()
        (process / "ns" / "pid").symlink_to("pid:[4026539999]")
        (process / "environ").write_bytes(("FULLMAG_API_RUNTIME_FAILURE_FENCE=/opt/fullmag/runtime-control/"
                                           + fence_relative + "\0").encode())
        (self.proc / "sys/kernel/random").mkdir(parents=True)
        (self.proc / "sys/kernel/random/boot_id").write_text("b" * 8 + "-1111-4222-8333-" + "c" * 12 + "\n")
        (self.proc / "self").symlink_to(str(pid))
        (self.proc / "thread-self").symlink_to(str(pid))
        interpreter = self.proc / "998"
        interpreter.mkdir()
        (interpreter / "exe").symlink_to("/usr/bin/python3")
        (interpreter / "cmdline").write_bytes(
            b"/usr/bin/python3\0-c\0print('/opt/fullmag/package/bin/fullmag-worker')\0")

    def _run_program(self, mode="live", expected=None):
        archive_attempt = "a" * 32 if mode == "archived" else None
        runtime = self.runtime
        ledger = self.ledger
        if mode == "archived":
            runtime = self.control / "runtime-archives" / archive_attempt
        script = subject.probe_program(roots={
            "runtime": runtime, "control": self.control, "state": self.state,
            "ledger": ledger, "proc": self.proc, "host_identity": self.host_identity,
        })
        payload = {"mode": mode, "request": self.request, "expected": expected,
                   "container_image_id": self.expected["target"]["image_id"]}
        if archive_attempt is not None:
            payload["archive_attempt"] = archive_attempt
        return subprocess.run([sys.executable, "-I", "-B", "-c", script], input=canonical(payload),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)

    def test_valid_diagnostic_failure_produces_store_and_free_lock_pins(self):
        result = self._run_program()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        value = json.loads(result.stdout)
        self.assertEqual(value["schema"], subject.OBSERVATION_SCHEMA)
        runtime = value["runtime"]
        self.assertEqual(runtime["process_sha256"], self.expected["process_sha256"])
        self.assertEqual(runtime["launch_sha256"], self.expected["launch_sha256"])
        self.assertEqual(runtime["input_sha256"], self.expected["input_sha256"])
        self.assertEqual(runtime["native_config_sha256"], self.expected["native_config_sha256"])
        self.assertEqual(runtime["failure_fence_relative"], self.expected["failure_fence_relative"])
        self.assertEqual(runtime["api_pin"]["boot_id"], "bbbbbbbb-1111-4222-8333-cccccccccccc")
        self.assertEqual(runtime["store_snapshot"], self.expected["store_snapshot"])
        self.assertEqual(set(value["native_locks"]), {"owner", "startup_gate", "launch", "host_inventory_owner"})
        self.assertTrue(all(lock["unlocked"] is True for lock in value["native_locks"].values()))

    def _assert_rejected(self, mutate, message):
        mutate()
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0, message)
        self.assertIn(message, result.stderr.decode(errors="replace"))

    def test_rejects_failure_fence_stage_and_api_identity_drift(self):
        fence_path = self.runtime / "runtime-service" / ("api-failure-" + "4" * 32 + ".json")
        self._assert_rejected(lambda: write_json(fence_path, {
            "schema": "fullmag.api-runtime-failure-fence.v1", "stage": "runtime_supervision",
            "api_pid": 321, "api_instance_id": self.api_id,
            "reason": "native startup failed before execution"}), "failure fence")
        self._reset()
        fence_path = self.runtime / "runtime-service" / ("api-failure-" + "4" * 32 + ".json")
        self._assert_rejected(lambda: write_json(fence_path, {
            "schema": "fullmag.api-runtime-failure-fence.v1", "stage": "runtime_startup",
            "api_pid": 321, "api_instance_id": self.old_api_id,
            "reason": "native startup failed before execution"}), "failure fence")

    def test_rejects_launch_target_and_run_intent_changes(self):
        request_dir = self.runtime / "held-ui-materialization" / self.request["plan"]["maintenance_request_id"]
        launch_path = request_dir / "launch.json"
        launch = json.loads(launch_path.read_bytes())
        launch["input"]["target_runtime"]["image_id"] = "sha256:" + "9" * 64
        write_json(launch_path, launch)
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("launch input", result.stderr.decode(errors="replace"))

        self._reset()
        store = self.state / "runs" / "docker-all" / "session-store"
        intent_path = store / "runs" / self.run_id / "run_intent.json"
        intent = json.loads(intent_path.read_bytes())
        intent["specification"]["parameters"]["live_workspace"]["session_epoch"] = 2
        write_json(intent_path, intent)
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("RunIntent", result.stderr.decode(errors="replace"))

    def test_rejects_ack_catalog_symlink_and_other_worker(self):
        request_dir = self.runtime / "held-ui-materialization" / self.request["plan"]["maintenance_request_id"]
        write_json(request_dir / ("restore-ack-" + self.launch_id + ".json"), {"state": "restored"})
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("acknowledgement", result.stderr.decode(errors="replace"))

        (request_dir / ("restore-ack-" + self.launch_id + ".json")).unlink()
        run_dir = self.state / "runs" / "docker-all" / "session-store" / "runs" / self.run_id
        write_json(run_dir / "run_catalog.json", {"run_id": self.run_id})
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("accepted run", result.stderr.decode(errors="replace"))

        (run_dir / "run_catalog.json").unlink()
        (run_dir / "unsafe-link").symlink_to("/etc/passwd")
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("run", result.stderr.decode(errors="replace"))

        (run_dir / "unsafe-link").unlink()
        worker = self.proc / "999"
        worker.mkdir()
        (worker / "exe").symlink_to("/opt/fullmag/package/bin/fullmag-worker")
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native worker", result.stderr.decode(errors="replace"))

    def test_rejects_locked_owner_and_wrong_accepted_store(self):
        import fcntl
        path = self.expected["lock_paths"]["host_inventory_owner"]
        descriptor = os.open(path, os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self._run_program()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("owner lock", result.stderr.decode(errors="replace"))
        finally:
            os.close(descriptor)

        self._reset()
        config_path = self.runtime / "runtime-service" / "docker-all.json"
        write_json(config_path, {"schema_version": "runtime_service_config.v2", "store_root": "/other/store"})
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("accepted store", result.stderr.decode(errors="replace"))

    def test_rejects_live_runtime_capability_and_missing_bootstrap_binding(self):
        process_path = self.runtime / "runtime-service" / "process-tree.json"
        process = json.loads(process_path.read_bytes())
        process["api_diagnostic_only"] = False
        write_json(process_path, process)
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("diagnostic", result.stderr.decode(errors="replace"))

        self._reset()
        process_path = self.runtime / "runtime-service" / "process-tree.json"
        process = json.loads(process_path.read_bytes())
        del process["bootstrap"]["binding"]
        write_json(process_path, process)
        result = self._run_program()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("accepted store", result.stderr.decode(errors="replace"))

    def test_stopped_observation_keeps_run_launch_and_lock_identities(self):
        expected = {"runtime": {"launch_id": self.launch_id,
                                "launch_sha256": self.expected["launch_sha256"],
                                "input_sha256": self.expected["input_sha256"],
                                "native_config_sha256": self.expected["native_config_sha256"],
                                "store_snapshot": self.expected["store_snapshot"]},
                    "native_locks": {key: {"device": path.stat().st_dev,
                                            "inode": path.stat().st_ino, "unlocked": True}
                                     for key, path in self.expected["lock_paths"].items()}}
        result = self._run_program(mode="stopped", expected=expected)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        value = json.loads(result.stdout)
        self.assertEqual(value["runtime"], expected["runtime"])
        self.assertEqual(value["native_locks"], expected["native_locks"])

        run_dir = self.state / "runs" / "docker-all" / "session-store" / "runs" / self.run_id
        write_json(run_dir / "live_demand.v1.json", {
            "schema_version": "fullmag.accepted_live_demand.v1", "run_id": self.run_id,
            "quantities": ["changed"]})
        result = self._run_program(mode="stopped", expected=expected)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("store", result.stderr.decode(errors="replace"))

    def test_archived_observation_allows_only_verified_certificate_rotation(self):
        import shutil

        live = self._run_program()
        self.assertEqual(live.returncode, 0, live.stderr.decode())
        live_value = json.loads(live.stdout)
        archive_attempt = "a" * 32
        archive = self.control / "runtime-archives" / archive_attempt
        shutil.copytree(self.runtime, archive)
        (archive / "group-ledger").parent.mkdir(parents=True, exist_ok=True)
        self.ledger.rename(archive / "group-ledger")
        self.ledger = archive / "group-ledger"

        # A completed normal certificate rotation changes image/readiness metadata,
        # while retaining the exact native host, owner token, and accepted store.
        rotated = json.loads(self.host_identity.read_bytes())
        rotated["restart_verified"] = False
        rotated["image_id"] = "sha256:" + "9" * 64
        write_json(self.host_identity, rotated)
        write_json(self.state / ".fullmag-linux-native-owner.json", rotated)

        expected = {"runtime": live_value["runtime"], "native_locks": live_value["native_locks"]}
        result = self._run_program(mode="archived", expected=expected)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        value = json.loads(result.stdout)
        self.assertEqual(value["runtime"]["store_snapshot"], live_value["runtime"]["store_snapshot"])
        self.assertEqual(value["native_locks"], live_value["native_locks"])
        self.assertEqual(value["released_snapshot_sha256"], live_value["released_snapshot_sha256"])

    def test_archived_observation_still_rejects_an_acknowledgement(self):
        import shutil

        live = self._run_program()
        self.assertEqual(live.returncode, 0, live.stderr.decode())
        expected = json.loads(live.stdout)
        archive_attempt = "a" * 32
        archive = self.control / "runtime-archives" / archive_attempt
        shutil.copytree(self.runtime, archive)
        self.ledger.rename(archive / "group-ledger")
        self.ledger = archive / "group-ledger"
        request_dir = archive / "held-ui-materialization" / self.request["plan"]["maintenance_request_id"]
        write_json(request_dir / ("restore-ack-" + self.launch_id + ".json"), {"state": "restored"})
        result = self._run_program(mode="archived", expected={
            "runtime": expected["runtime"], "native_locks": expected["native_locks"]})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("acknowledgement", result.stderr.decode(errors="replace"))


class RetryProbeMountTests(unittest.TestCase):
    def test_runtime_archive_roots_match_retained_volume_mount_destinations(self):
        attempt = "a" * 32
        self.assertEqual(subject._roots_for("stopped")["runtime"], "/opt/fullmag/runtime-control")
        self.assertEqual(subject._roots_for("archived", attempt)["runtime"],
                         "/opt/fullmag/control/runtime-archives/" + attempt)
        self.assertEqual(subject._roots_for("archived", attempt)["ledger"],
                         "/opt/fullmag/control/runtime-archives/" + attempt + "/group-ledger")

    def test_archived_probe_mounts_the_real_control_volume_destination(self):
        attempt = "a" * 32
        actual = {"Id": "a" * 64, "Image": "sha256:" + "1" * 64}
        expected = {"runtime": {}, "native_locks": {}}
        response = type("Result", (), {
            "returncode": 0,
            "stdout": canonical({"schema": subject.OBSERVATION_SCHEMA, "runtime": {},
                                 "native_locks": {}, "released_snapshot_sha256": "0" * 64}),
            "stderr": b"",
        })()
        seen = {}

        def fake_capture(*args, **kwargs):
            seen["args"] = args
            return response

        with mock.patch("docker_volume_linux_supervision_stop.readonly_mount",
                        side_effect=lambda container, target: "mount:" + target), \
             mock.patch.object(subject, "docker_capture", side_effect=fake_capture):
            subject._run_probe(actual, {"source_scope": {"compose_project": "fullmag-test"}},
                               mode="archived", expected=expected, archive_attempt=attempt)
        args = seen["args"]
        mounts = [args[index + 1] for index, item in enumerate(args[:-1]) if item == "--mount"]
        self.assertIn("mount:/opt/fullmag/control", mounts)
        self.assertNotIn("mount:/control", mounts)
        self.assertNotIn("mount:/runtime-control", mounts)


if __name__ == "__main__":
    unittest.main()
