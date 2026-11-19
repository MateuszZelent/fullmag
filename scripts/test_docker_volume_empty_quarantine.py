from __future__ import annotations

import ast
import hashlib
import io
import json
import os
from pathlib import Path
import select
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_control_namespace as namespace
import docker_volume_dev as volume_dev
import docker_volume_empty_quarantine as quarantine


def _owner(state="ready"):
    return {
        "schema_version": "runtime_service_owner.v1",
        "protocol": "stdin-v1",
        "state": state,
        "owner_token": "1" * 32,
        "process_start_token": "process-start",
        "pid": 31,
        "host": "docker-host",
        "target_id": "docker-all",
        "control_address": "unix:///runtime/control.sock",
        "acquired_at": "2026-10-23T00:00:00Z",
        "heartbeat_at": "2026-10-23T00:00:01Z",
        "build_commit": "2" * 40,
        "build_snapshot": "3" * 64,
        "compute_pool_id": "compute-pool",
        "preparation_pool_id": "preparation-pool",
        "compute_pool_generation": 7,
        "preparation_pool_generation": 8,
        "children": [
            {"role": "compute", "pid": 41, "status": "running"},
            {"role": "preparation", "pid": 42, "status": "running"},
        ],
    }


def _stopped_row(service="backend", *, running=False, pid=0, exit_code=255,
                 restart_count=0, privileged=False, started="2026-10-23T22:00:00Z"):
    return {
        "Id": "a" * 64,
        "Name": "/fullmag-test-" + service + "-1",
        "Image": "sha256:" + "b" * 64,
        "RestartCount": restart_count,
        "Config": {"Labels": {
            "com.docker.compose.project": "fullmag-test",
            "com.docker.compose.service": service,
        }},
        "HostConfig": {"PidMode": "", "Privileged": privileged},
        "State": {
            "Running": running, "Pid": pid,
            "Status": "running" if running else "exited",
            "ExitCode": exit_code, "OOMKilled": False,
            "Restarting": False, "Paused": False, "Dead": False,
            "StartedAt": started, "FinishedAt": "2026-10-23T23:17:26Z",
        },
    }


def _completed(returncode=0, stdout=b"", stderr=b""):
    return subprocess.CompletedProcess(["docker"], returncode, stdout, stderr)


def _intent_record(recovery_id="c" * 32):
    control_volume = "fullmag-control-v1-test"
    ledger_volume = "fullmag-dev-group-ledger-v1-old"
    pair = {}
    for service, character in (("backend", "a"), ("frontend", "b")):
        container_id = character * 64
        row = _stopped_row(service)
        row["Id"] = container_id
        evidence = quarantine._validate_stopped_container(
            row, container_id=container_id, image_id="sha256:" + "b" * 64,
            project="fullmag-test", service=service,
        )
        evidence["name"] = "fullmag-test-" + service + "-1"
        evidence["network_names"] = ["fullmag-test_default"]
        pair[service] = evidence
    pins = {
        "active": "1" * 64,
        "activation/attempts/" + "c" * 32 + "/receipt.json": "2" * 64,
        "backend/script-activation-" + "d" * 64 + "/activation.json": "3" * 64,
        "development/attempts/" + "e" * 32 + "/terminal.json": "4" * 64,
        "development/attempts/" + "e" * 32 + "/compose.json": "5" * 64,
        "runtime-control/runtime-services/OWNER.json": "6" * 64,
        "runtime-control/runtime-services/LAUNCH.json": "7" * 64,
        "runtime-control/runtime-service/process-tree.json": "8" * 64,
    }
    return {
        "schema": quarantine.INTENT_SCHEMA,
        "state": "removal-authorized",
        "scope": quarantine.SCOPE,
        "recovery_id": recovery_id,
        "namespace": "namespaces/" + recovery_id,
        "compose_project": "fullmag-test",
        "control_volume": control_volume,
        "source_root": "/workspace/test-worktree",
        "source_project_id": "test-project-id",
        "source_worktree_id": "test-worktree-id",
        "old_activation_attempt": "c" * 32,
        "old_request_id": "test-request",
        "old_activation_outcome": "unknown-retained",
        "activation_receipt_path": "activation/attempts/" + "c" * 32 + "/receipt.json",
        "activation_marker_path": "backend/script-activation-" + "d" * 64 + "/activation.json",
        "development_attempt": "e" * 32,
        "development_terminal_path": "development/attempts/" + "e" * 32 + "/terminal.json",
        "development_compose_path": "development/attempts/" + "e" * 32 + "/compose.json",
        "config_sha256": "9" * 64,
        "control_pins": pins,
        "activation_marker_sha256": pins["backend/script-activation-" + "d" * 64 + "/activation.json"],
        "helper_absence_sha256": "a" * 64,
        "stopped_pair": pair,
        "network_sha256": "b" * 64,
        "retained_store_snapshot": {
            "directories": sorted(quarantine.EMPTY_STORE_DIRECTORIES),
            "files": {name: "c" * 64 for name in quarantine.EMPTY_STORE_FILES},
        },
        "retained_state_root": "/workspace/storage/test-state",
        "protected_state_sources": [
            "/workspace/storage/test-state",
            "/run/desktop/mnt/host/c/fullmag/storage/test-state",
        ],
        "ledger_volume": ledger_volume,
        "ledger_sha256": "d" * 64,
        "empty_reservation_count": 0,
        "docker_engine_id": "test-engine",
        "verified_helper_image_id": "sha256:" + "e" * 64,
        "protected_volumes": [control_volume, ledger_volume, "fullmag-dev-cache-test"],
        "allow_new_requests": True,
        "allow_old_request_replay": False,
        "authorization": "explicit-user-recovery-and-new-start",
        "created_at": 1.0,
    }


def _write_file(root: Path, relative: str, data: bytes) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _generated_helper_fixture(root: Path):
    control_root = root / "control"
    ledger_mount = root / "ledger-mount"
    retained_root = root / "retained"
    control_root.mkdir()
    (ledger_mount / "ledger").mkdir(parents=True)
    retained_root.mkdir()
    for relative in (
        "operation.lock",
        "runtime-control/runtime-services/STARTUP-GATE.lock",
        "runtime-control/runtime-services/LAUNCH.lock",
        "runtime-control/runtime-services/OWNER.lock",
    ):
        _write_file(control_root, relative, b"")
    _write_file(ledger_mount, "ledger/WRITER.lock", b"")
    _write_file(ledger_mount, "ledger/HOST_INVENTORY_OWNER.lock", b"")
    ledger_raw = quarantine.canonical({
        "schema_version": "host_resource_ledger.v4", "reservations": [],
    })
    _write_file(ledger_mount, "ledger/HOST_RESOURCE_LEDGER.json", ledger_raw)

    intent = _intent_record("f" * 32)
    intent["ledger_sha256"] = hashlib.sha256(ledger_raw).hexdigest()
    pin_paths = list(intent["control_pins"])
    control_contents = {"active": b"activation\n"}
    for relative in pin_paths:
        if relative != "active":
            control_contents[relative] = b"{}\n"
    for relative, data in control_contents.items():
        _write_file(control_root, relative, data)
    intent["control_pins"] = {
        relative: hashlib.sha256(data).hexdigest()
        for relative, data in control_contents.items()
    }
    intent["activation_marker_sha256"] = intent["control_pins"][intent["activation_marker_path"]]

    for relative in quarantine.EMPTY_STORE_DIRECTORIES:
        (retained_root / relative).mkdir(parents=True, exist_ok=True)
    store_contents = {
        "WRITER.lock": b"",
        "WRITER.owner.json": b'{"schema":"fullmag.writer.v1","released":true}\n',
        "scheduler_pools/docker-all.compute.resources.json": b"{}\n",
        "scheduler_pools/docker-all.preparation.preparation-resources.json": b"{}\n",
    }
    for relative, data in store_contents.items():
        _write_file(retained_root, relative, data)
    intent["retained_store_snapshot"] = {
        "directories": sorted(quarantine.EMPTY_STORE_DIRECTORIES),
        "files": {relative: hashlib.sha256(data).hexdigest()
                  for relative, data in store_contents.items()},
    }
    intent_raw = quarantine.canonical(intent) + b"\n"
    record = {
        **intent,
        "schema": quarantine.SCHEMA,
        "state": "quarantined-empty-not-replayed",
        "intent_path": "namespace-recovery/" + intent["recovery_id"] + "/intent.json",
        "intent_sha256": hashlib.sha256(intent_raw).hexdigest(),
    }
    script = quarantine._transaction_script()
    script = script.replace("P('/control')", "P(" + repr(str(control_root)) + ")")
    for relative in (
        "WRITER.lock", "HOST_INVENTORY_OWNER.lock", "HOST_RESOURCE_LEDGER.json",
    ):
        original = "P('/ledger/ledger/" + relative + "')"
        mapped = "P(" + repr(str(ledger_mount / "ledger" / relative)) + ")"
        script = script.replace(original, mapped)
    script = script.replace("P('/retained/WRITER.lock')",
                            "P(" + repr(str(retained_root / "WRITER.lock")) + ")")
    script = script.replace("'/retained'", repr(str(retained_root)))
    return script, record, intent, control_root, ledger_mount, retained_root, ledger_raw, store_contents, control_contents


def _run_generated_helper(script: str, record: dict, intent: dict):
    process = subprocess.Popen(
        [sys.executable, "-I", "-B", "-c", script],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    process.stdin.write(quarantine.canonical({"record": record, "intent": intent}) + b"\n")
    process.stdin.flush()
    ready, _, _ = select.select([process.stdout], [], [], 10)
    if not ready:
        process.kill()
        process.communicate(timeout=5)
        raise AssertionError("Generated transaction helper did not acknowledge its durable intent")
    return process


class EmptyStoreAdmissionTests(unittest.TestCase):
    def test_only_four_allowlisted_technical_files_are_accepted(self):
        snapshot = {
            "directories": sorted(quarantine.EMPTY_STORE_DIRECTORIES),
            "files": {name: "a" * 64 for name in quarantine.EMPTY_STORE_FILES},
        }
        self.assertEqual(quarantine._validate_empty_store_snapshot(snapshot), snapshot)
        changed = {**snapshot, "files": {**snapshot["files"], "runs/run-1/run_intent.json": "b" * 64}}
        with self.assertRaises(quarantine.BuildControlError):
            quarantine._validate_empty_store_snapshot(changed)

    def test_run_directories_and_unknown_files_are_rejected(self):
        snapshot = {
            "directories": sorted(quarantine.EMPTY_STORE_DIRECTORIES | {"runs/run-1"}),
            "files": {name: "a" * 64 for name in quarantine.EMPTY_STORE_FILES},
        }
        with self.assertRaises(quarantine.BuildControlError):
            quarantine._validate_empty_store_snapshot(snapshot)

    def test_ledger_must_be_v4_with_literal_empty_reservations(self):
        self.assertEqual(quarantine._validate_empty_ledger({
            "schema_version": "host_resource_ledger.v4", "reservations": [],
        })["reservations"], [])
        for reservations in ([{"state": "released"}], {}, None):
            with self.subTest(reservations=reservations):
                with self.assertRaises(quarantine.BuildControlError):
                    quarantine._validate_empty_ledger({
                        "schema_version": "host_resource_ledger.v4",
                        "reservations": reservations,
                    })

    def test_stopped_container_is_bound_to_exact_private_incarnation(self):
        row = _stopped_row()
        evidence = quarantine._validate_stopped_container(
            row, container_id="a" * 64, image_id="sha256:" + "b" * 64,
            project="fullmag-test", service="backend",
        )
        self.assertEqual(evidence["exit_code"], 255)
        self.assertEqual(evidence["restart_count"], 0)
        for altered in (
            _stopped_row(running=True, pid=9),
            _stopped_row(pid=9),
            _stopped_row(exit_code=0),
            _stopped_row(restart_count=1),
            _stopped_row(privileged=True),
        ):
            with self.subTest(state=altered["State"], host=altered["HostConfig"]):
                with self.assertRaises(quarantine.BuildControlError):
                    quarantine._validate_stopped_container(
                        altered, container_id="a" * 64, image_id="sha256:" + "b" * 64,
                        project="fullmag-test", service="backend",
                    )

    def test_new_receipt_has_separate_scope_and_cannot_replay(self):
        receipt = {
            "schema": quarantine.SCHEMA,
            "state": "quarantined-empty-not-replayed",
            "scope": quarantine.SCOPE,
            "recovery_id": "c" * 32,
            "namespace": "namespaces/" + "c" * 32,
            "compose_project": "fullmag-test",
            "control_volume": "control-volume",
            "source_worktree_id": "worktree",
            "source_project_id": "project",
            "old_request_id": "request-id",
            "allow_new_requests": True,
            "allow_old_request_replay": False,
        }
        self.assertTrue(quarantine._validate_empty_namespace_receipt(
            receipt, namespace=receipt["namespace"], project="fullmag-test",
            volume="control-volume", worktree_id="worktree", project_id="project",
        ))
        self.assertTrue(namespace._is_empty_stopped_quarantine_receipt(
            receipt, namespace=receipt["namespace"], project="fullmag-test",
            volume="control-volume", worktree_id="worktree", project_id="project",
        ))
        self.assertFalse(namespace._is_quarantined_receipt(
            receipt, namespace=receipt["namespace"], project="fullmag-test",
            volume="control-volume", worktree_id="worktree", project_id="project",
        ))
        receipt["allow_old_request_replay"] = True
        self.assertFalse(namespace._is_empty_stopped_quarantine_receipt(
            receipt, namespace=receipt["namespace"], project="fullmag-test",
            volume="control-volume", worktree_id="worktree", project_id="project",
        ))

    def test_fresh_ledger_generation_uses_only_valid_empty_quarantine_scope(self):
        recovery_id = "d" * 32
        control = type("Control", (), {
            "namespace": "namespaces/" + recovery_id,
            "namespace_registry": {"retirement": {
                "schema": quarantine.SCHEMA,
                "scope": quarantine.SCOPE,
                "state": "quarantined-empty-not-replayed",
                "recovery_id": recovery_id,
                "ledger_volume": "fullmag-dev-group-ledger-v1-old",
            }},
        })()
        self.assertEqual(volume_dev._empty_stopped_namespace_ledger_generation(control), recovery_id)
        control.namespace = "namespaces/" + "e" * 32
        with self.assertRaises(volume_dev.BuildControlError):
            volume_dev._empty_stopped_namespace_ledger_generation(control)
        control.namespace_registry["retirement"]["schema"] = "fullmag.docker-control-namespace-quarantine.v1"
        self.assertIsNone(volume_dev._empty_stopped_namespace_ledger_generation(control))

    def test_cold_terminal_quarantine_uses_its_own_ledger_generation(self):
        token = "d" * 32
        record = {"schema": "fullmag.docker-failed-bootstrap-quarantine.v1",
                  "state": "failed-bootstrap-quarantined-not-drained",
                  "recovery_id": token, "ledger_volume": "fullmag-dev-group-ledger-v1-old",
                  "native_owner_drained": False, "allow_old_request_replay": False}
        control = type("Control", (), {"namespace": "namespaces/" + token,
                                       "namespace_registry": {"retirement": record}})()
        self.assertEqual(volume_dev._empty_stopped_namespace_ledger_generation(control), token)
        for field, value in (("state", "drained"), ("native_owner_drained", True),
                             ("allow_old_request_replay", True)):
            original = record[field]
            record[field] = value
            with self.subTest(field=field), self.assertRaises(volume_dev.BuildControlError):
                volume_dev._empty_stopped_namespace_ledger_generation(control)
            record[field] = original
        control.namespace = "namespaces/" + "e" * 32
        with self.assertRaises(volume_dev.BuildControlError):
            volume_dev._empty_stopped_namespace_ledger_generation(control)

    def test_cold_private_ledger_reuses_volume_only_for_a_distinct_namespace_subpath(self):
        token = "d" * 32
        record = {"schema": "fullmag.docker-failed-bootstrap-quarantine.v1",
                  "ledger_volume": "stable-control",
                  "ledger_subpath": "namespaces/" + "c" * 32 + "/private/ledger"}
        control = type("Control", (), {"namespace": "namespaces/" + token,
                                       "volume": "stable-control",
                                       "namespace_registry": {"retirement": record}})()
        volume_dev._validate_empty_quarantine_ledger_volume(control, token, control.volume)
        for subpath in ("", "../private/ledger", control.namespace + "/private/ledger"):
            record["ledger_subpath"] = subpath
            with self.subTest(subpath=subpath), self.assertRaises(volume_dev.BuildControlError):
                volume_dev._validate_empty_quarantine_ledger_volume(control, token, control.volume)

    def test_existing_archive_rotation_wins_and_old_root_needs_no_namespace_registry(self):
        self.assertEqual(volume_dev._select_group_ledger_generation(
            "d" * 32, {"generation": "e" * 32}), "e" * 32)
        self.assertEqual(volume_dev._select_group_ledger_generation("d" * 32, None), "d" * 32)
        old_root = type("Control", (), {"namespace": None, "namespace_registry": None})()
        volume_dev._validate_empty_quarantine_ledger_volume(old_root, None, "old-volume")

    def test_empty_quarantine_cannot_resolve_to_old_ledger_volume(self):
        control = type("Control", (), {
            "namespace_registry": {"retirement": {"ledger_volume": "old-volume"}},
        })()
        with self.assertRaises(volume_dev.BuildControlError):
            volume_dev._validate_empty_quarantine_ledger_volume(control, "d" * 32, "old-volume")
        volume_dev._validate_empty_quarantine_ledger_volume(control, "d" * 32, "new-volume")

    def test_request_derived_marker_and_ready_owner_identity_are_pinned(self):
        request_id = "12345678-1234-4234-8234-123456789abc"
        marker_key = hashlib.sha256(request_id.encode()).hexdigest()
        marker_path = "backend/script-activation-" + marker_key + "/activation.json"
        source_sha, provenance_sha = "4" * 64, "5" * 64
        activation = {
            "request_id": request_id,
            "inputs": {
                "request_id": request_id,
                "activation_receipt_key": marker_key,
                "activation_receipt_path": "/opt/fullmag/control/" + marker_path,
                "source_sha256": source_sha,
                "provenance_sha256": provenance_sha,
            },
        }
        owner = _owner()
        process_owner = {**owner, "heartbeat_at": "2026-10-23T00:00:02Z"}
        records = {
            "active": b"f" * 32 + b"\n",
            marker_path: json.dumps({
                "schema": "fullmag.docker-startup-activation-receipt.v1",
                "state": "started", "request_id": request_id,
                "source_sha256": source_sha, "provenance_sha256": provenance_sha,
                "authorization": {"request_id": request_id, "source_sha256": source_sha},
            }).encode(),
            "runtime-control/runtime-services/OWNER.json": json.dumps(owner).encode(),
            "runtime-control/runtime-service/process-tree.json": json.dumps({
                "schema": "fullmag.docker-process-tree.v1", "state": "ready",
                "service_owner": process_owner,
            }).encode(),
        }
        for path in (
            "activation/attempts/" + "f" * 32 + "/receipt.json",
            "development/attempts/" + "1" * 32 + "/terminal.json",
            "development/attempts/" + "1" * 32 + "/compose.json",
            "runtime-control/runtime-services/LAUNCH.json",
        ):
            records[path] = b"{}"
        class Control:
            def path(self, relative):
                return "/control/" + relative
        with patch.object(quarantine, "_read_control_raw", side_effect=lambda _, path, **__: records[path]):
            pins, _ = quarantine._pinned_control_records(
                Control(), "f" * 32, activation, "1" * 32,
            )
        self.assertEqual(pins[marker_path], hashlib.sha256(records[marker_path]).hexdigest())
        records[marker_path] = records[marker_path].replace(b'"started"', b'"failed"')
        with patch.object(quarantine, "_read_control_raw", side_effect=lambda _, path, **__: records[path]):
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._pinned_control_records(Control(), "f" * 32, activation, "1" * 32)

    def test_intent_cas_and_changed_intent_id_fail_closed(self):
        record = _intent_record()
        control = type("Control", (), {
            "project": "fullmag-test",
            "volume": record["control_volume"],
            "identity": {
                "project_id": record["source_project_id"],
                "worktree_id": record["source_worktree_id"],
            },
        })()
        args = type("Args", (), {
            "recovery_id": record["recovery_id"],
            "activation": record["old_activation_attempt"],
        })()
        terminal = {
            "state": "succeeded",
            "state_root": record["retained_state_root"],
            "backend_container": record["stopped_pair"]["backend"]["id"],
            "frontend_container": record["stopped_pair"]["frontend"]["id"],
        }
        with patch.object(quarantine, "_read_control_json", return_value=terminal), \
                patch("docker_control_namespace._validate_empty_stopped_control_pins"):
            quarantine._validate_intent(record, args, control, Path(record["source_root"]))
            altered = {**record, "recovery_id": "e" * 32}
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._validate_intent(altered, args, control, Path(record["source_root"]))
            altered = {**record, "empty_reservation_count": 1}
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._validate_intent(altered, args, control, Path(record["source_root"]))
            altered = {**record, "stopped_pair": {
                **record["stopped_pair"],
                "backend": {**record["stopped_pair"]["backend"], "name": "foreign-backend"},
            }}
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._validate_intent(altered, args, control, Path(record["source_root"]))

    def test_namespace_pin_cas_rejects_changed_control_bytes(self):
        paths = {
            "active": b"activation\n",
            "activation/attempts/" + "a" * 32 + "/receipt.json": b"activation receipt",
            "backend/script-activation-" + "b" * 64 + "/activation.json": b"started marker",
            "development/attempts/" + "c" * 32 + "/terminal.json": b"terminal",
            "development/attempts/" + "c" * 32 + "/compose.json": b"compose",
            "runtime-control/runtime-services/OWNER.json": b"owner",
            "runtime-control/runtime-services/LAUNCH.json": b"launch",
            "runtime-control/runtime-service/process-tree.json": b"process tree",
        }
        receipt = {
            "activation_receipt_path": "activation/attempts/" + "a" * 32 + "/receipt.json",
            "activation_marker_path": "backend/script-activation-" + "b" * 64 + "/activation.json",
            "development_terminal_path": "development/attempts/" + "c" * 32 + "/terminal.json",
            "development_compose_path": "development/attempts/" + "c" * 32 + "/compose.json",
            "control_pins": {path: hashlib.sha256(data).hexdigest() for path, data in paths.items()},
        }
        control = type("Control", (), {"path": lambda self, rel: "/control/" + rel})()
        with patch("docker_control_namespace._raw", side_effect=lambda _, rel: paths[rel]):
            namespace._validate_empty_stopped_control_pins(control, receipt)
            receipt["control_pins"]["active"] = "f" * 64
            with self.assertRaises(namespace.BuildControlError):
                namespace._validate_empty_stopped_control_pins(control, receipt)

    def test_partial_removal_accepts_only_exact_survivor_and_absent_name(self):
        record = _intent_record()
        backend, frontend = record["stopped_pair"]["backend"], record["stopped_pair"]["frontend"]
        backend_missing = _completed(
            1, stderr=("Error: No such object: " + backend["id"]).encode(),
        )
        frontend_row = _stopped_row("frontend")
        frontend_row["Id"] = frontend["id"]
        with patch.object(quarantine, "docker_capture", side_effect=[
                backend_missing, _completed(stdout=json.dumps([frontend_row]).encode())]) as capture, \
                patch("docker_volume_fresh_runtime._assert_exact_absence") as exact_absence, \
                patch("docker_volume_activation_reconcile._probe_helper_absence",
                      side_effect=lambda name: "f" * 64 if name == backend["name"] else None) as name_probe:
            self.assertEqual(quarantine._pair_presence(record), [frontend["id"]])
        exact_absence.assert_called_once_with(backend["id"], "backend")
        name_probe.assert_any_call(backend["name"])
        self.assertEqual(capture.call_count, 2)

    def test_partial_removal_rejects_changed_running_pair_and_reused_name(self):
        record = _intent_record()
        backend, frontend = record["stopped_pair"]["backend"], record["stopped_pair"]["frontend"]
        backend_missing = _completed(1, stderr=("No such object: " + backend["id"]).encode())
        running = _stopped_row("frontend", running=True, pid=37)
        running["Id"] = frontend["id"]
        with patch.object(quarantine, "docker_capture", side_effect=[
                backend_missing, _completed(stdout=json.dumps([running]).encode())]), \
                patch("docker_volume_fresh_runtime._assert_exact_absence"), \
                patch("docker_volume_activation_reconcile._probe_helper_absence",
                      return_value="f" * 64):
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._pair_presence(record)
        with patch.object(quarantine, "docker_capture", return_value=backend_missing), \
                patch("docker_volume_fresh_runtime._assert_exact_absence"), \
                patch("docker_volume_activation_reconcile._probe_helper_absence",
                      return_value=None):
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._pair_presence(record)

    def test_external_revalidation_rejects_old_helper_engine_network_and_consumers(self):
        record = _intent_record()
        control = type("Control", (), {"project": record["compose_project"]})()
        info = _completed(stdout=(record["docker_engine_id"] + "\n").encode())
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value="f" * 64) as helper, \
                patch.object(quarantine, "docker_capture", return_value=info), \
                patch.object(quarantine, "_network_inventory", return_value=record["network_sha256"]), \
                patch.object(quarantine, "_project_inventory") as inventory, \
                patch.object(quarantine, "_pair_presence", return_value=[record["stopped_pair"]["backend"]["id"]]):
            result = quarantine._revalidate_external(record, control, "new-helper")
        self.assertEqual(result, [record["stopped_pair"]["backend"]["id"]])
        self.assertEqual(helper.call_args.args[0], "fullmag-control-" + record["old_activation_attempt"])
        self.assertEqual(inventory.call_args.kwargs["state_sources"], record["protected_state_sources"])
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value=None):
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._revalidate_external(record, control)
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value="f" * 64), \
                patch.object(quarantine, "docker_capture", return_value=info), \
                patch.object(quarantine, "_network_inventory", return_value="changed"):
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._revalidate_external(record, control)
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value="f" * 64), \
                patch.object(quarantine, "docker_capture", return_value=info), \
                patch.object(quarantine, "_network_inventory", return_value=record["network_sha256"]), \
                patch.object(quarantine, "_project_inventory",
                             side_effect=quarantine.BuildControlError("foreign mount consumer")):
            with self.assertRaisesRegex(quarantine.BuildControlError, "foreign mount consumer"):
                quarantine._revalidate_external(record, control)

    def test_network_identity_hash_survives_owned_endpoint_removal_only(self):
        project, name = "fullmag-test", "fullmag-test_default"
        backend, frontend, foreign = "a" * 64, "b" * 64, "c" * 64
        base = {
            "Name": name,
            "Id": "d" * 64,
            "Driver": "bridge",
            "Labels": {"com.docker.compose.project": project},
            "Containers": {backend: {}, frontend: {}},
        }
        allowed = {backend, frontend}
        with patch.object(quarantine, "docker_capture",
                          return_value=_completed(stdout=json.dumps([base]).encode())):
            initial = quarantine._network_inventory(project, [name], allowed)
        after_removal = {**base, "Containers": {}}
        with patch.object(quarantine, "docker_capture",
                          return_value=_completed(stdout=json.dumps([after_removal]).encode())):
            self.assertEqual(quarantine._network_inventory(project, [name], allowed), initial)
        replaced = {**after_removal, "Id": "e" * 64}
        with patch.object(quarantine, "docker_capture",
                          return_value=_completed(stdout=json.dumps([replaced]).encode())):
            self.assertNotEqual(quarantine._network_inventory(project, [name], allowed), initial)
        foreign_consumer = {**base, "Containers": {backend: {}, frontend: {}, foreign: {}}}
        with patch.object(quarantine, "docker_capture",
                          return_value=_completed(stdout=json.dumps([foreign_consumer]).encode())):
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._network_inventory(project, [name], allowed)

    def test_inventory_rejects_opaque_state_alias_but_ignores_unrelated_user_data(self):
        control = type("Control", (), {"project": "fullmag-test"})()
        identifier = "f" * 64
        outputs = [
            _completed(stdout=(identifier + "\n").encode()),
            _completed(stdout=json.dumps([{
                "Id": identifier,
                "Config": {"Labels": {"com.docker.compose.project": "another-group"}},
                "HostConfig": {"Mounts": [{
                    "Type": "bind", "Source": "/run/docker/opaque/wsldata/state-alias",
                    "Target": "/state", "ReadOnly": True,
                }]},
                "Mounts": [],
            }]).encode()),
        ]
        with patch.object(quarantine, "docker_capture", side_effect=outputs):
            with self.assertRaisesRegex(quarantine.BuildControlError, "another consumer"):
                quarantine._project_inventory(
                    control, {}, protected_volumes=set(), state_root=Path("/workspace/state"),
                    ledger_volume="fullmag-dev-group-ledger-v1-old",
                    state_sources=["/run/docker/opaque/wsldata/state-alias"],
                )
        outputs = [
            _completed(stdout=(identifier + "\n").encode()),
            _completed(stdout=json.dumps([{
                "Id": identifier,
                "Config": {"Labels": {"com.docker.compose.project": "another-group"}},
                "HostConfig": {"Mounts": [{
                    "Type": "bind", "Source": "/storage/user-data", "Target": "/user-data",
                    "ReadOnly": False,
                }]},
                "Mounts": [],
            }]).encode()),
        ]
        with patch.object(quarantine, "docker_capture", side_effect=outputs):
            self.assertEqual(quarantine._project_inventory(
                control, {}, protected_volumes=set(), state_root=Path("/workspace/state"),
                ledger_volume="fullmag-dev-group-ledger-v1-old",
                state_sources=["/run/docker/opaque/wsldata/state-alias"],
            ), [identifier])

    def test_generated_helper_publishes_intent_before_lock_ack_and_cas_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (script, record, intent, control_root, ledger_mount, retained_root,
             ledger_raw, store_contents, control_contents) = _generated_helper_fixture(root)
            ast.parse(script)
            process = _run_generated_helper(script, record, intent)
            try:
                line = process.stdout.readline().decode("utf-8", "strict").strip()
                self.assertEqual(line, "LOCKED")
                intent_path = control_root / record["intent_path"]
                self.assertTrue(intent_path.is_file())
                intent_raw = intent_path.read_bytes()
                self.assertEqual(intent_raw, quarantine.canonical(intent) + b"\n")
                self.assertEqual(hashlib.sha256(intent_raw).hexdigest(), record["intent_sha256"])
                process.stdin.write(b"COMMIT\n")
                process.stdin.flush()
                remaining_stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr.decode("utf-8", "replace"))
                result = json.loads(remaining_stdout)
                self.assertEqual(result["state"], record["state"])
                self.assertEqual(result["namespace"], record["namespace"])

                receipt_path = control_root / "namespace-recovery" / record["recovery_id"] / "terminal.json"
                receipt_raw = receipt_path.read_bytes()
                registry = json.loads((control_root / "namespaces/current.json").read_bytes())
                self.assertEqual(registry["receipt_sha256"], hashlib.sha256(receipt_raw).hexdigest())
                self.assertEqual(
                    (control_root / record["namespace"] / "namespace.json").read_bytes(), receipt_raw,
                )
                self.assertEqual(
                    (control_root / record["namespace"] / "operation.lock").stat().st_ino,
                    (control_root / "operation.lock").stat().st_ino,
                )
                self.assertEqual(ledger_raw,
                                 (ledger_mount / "ledger/HOST_RESOURCE_LEDGER.json").read_bytes())
                for relative, data in store_contents.items():
                    self.assertEqual(data, (retained_root / relative).read_bytes())
                for relative, data in control_contents.items():
                    self.assertEqual(data, (control_root / relative).read_bytes())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)

    def test_generated_helper_refuses_control_mutation_after_locked_intent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (script, record, intent, control_root, _, _, _, _, _) = _generated_helper_fixture(root)
            process = _run_generated_helper(script, record, intent)
            try:
                self.assertEqual(process.stdout.readline().decode().strip(), "LOCKED")
                self.assertTrue((control_root / record["intent_path"]).is_file())
                (control_root / "active").write_bytes(b"changed-active\n")
                process.stdin.write(b"COMMIT\n")
                process.stdin.flush()
                _, stderr = process.communicate(timeout=10)
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse((control_root / "namespaces/current.json").exists())
                self.assertIn(b"control pin changed", stderr)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)

    def test_apply_removes_only_exact_survivors_without_force_or_volume_flags(self):
        record = _intent_record()
        backend = record["stopped_pair"]["backend"]["id"]
        frontend = record["stopped_pair"]["frontend"]["id"]
        result_line = json.dumps({
            "state": "quarantined-empty-not-replayed",
            "namespace": record["namespace"],
        })

        class Input:
            def __init__(self):
                self.data = bytearray()
                self.closed = False
            def write(self, value):
                self.data.extend(value)
            def flush(self):
                pass
            def close(self):
                self.closed = True

        class Process:
            def __init__(self):
                self.stdin = Input()
                self.stderr = io.BytesIO()
                self.status = None
            def wait(self, timeout=None):
                self.status = 0
                return 0
            def poll(self):
                return self.status

        class Control:
            image = "base-image"
            def __init__(self):
                self.lines = ["LOCKED", result_line]
            def helper_args(self, script, name=None):
                return ["docker", "run", "--network", "none", "--mount",
                        "type=volume,src=control,dst=/control,volume-nocopy",
                        self.image, "--entrypoint", "/bin/bash", "-c", script]
            def _line(self, process):
                return self.lines.pop(0)

        control = Control()
        proof = {
            "record": record,
            "control": control,
            "store_root": "/storage/retained-store",
            "ledger_mount": "type=volume,src=" + record["ledger_volume"] + ",dst=/ledger,readonly,volume-nocopy",
        }
        process = Process()
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value="a" * 64), \
                patch.object(quarantine.subprocess, "Popen", return_value=process) as popen, \
                patch.object(quarantine, "_revalidate_external", side_effect=[[backend, frontend], []]), \
                patch.object(quarantine, "_pair_presence", side_effect=[[backend, frontend], [backend, frontend]]), \
                patch.object(quarantine, "docker_capture", return_value=_completed()) as docker:
            result = quarantine._apply_transaction(proof)
        self.assertEqual(result["namespace"], record["namespace"])
        rm_calls = [(call.args, call.kwargs) for call in docker.call_args_list
                    if call.args and call.args[0] == "rm"]
        self.assertEqual(rm_calls, [
            (("rm", backend), {"timeout": 90}),
            (("rm", frontend), {"timeout": 90}),
        ])
        command = popen.call_args.args[0]
        self.assertEqual(command[command.index("--network") + 1], "none")
        mounts = [command[i + 1] for i, value in enumerate(command[:-1]) if value == "--mount"]
        self.assertTrue(any(value.startswith("type=bind,") and value.endswith(",readonly") for value in mounts))
        self.assertFalse(any("docker.sock" in value for value in mounts))
        self.assertNotIn("--force", command)
        self.assertNotIn("-f", command)
        self.assertNotIn("-v", command)

    def test_apply_resume_removes_only_remaining_container_and_detects_boundary_race(self):
        record = _intent_record()
        backend = record["stopped_pair"]["backend"]["id"]
        frontend = record["stopped_pair"]["frontend"]["id"]
        result_line = json.dumps({
            "state": "quarantined-empty-not-replayed",
            "namespace": record["namespace"],
        })

        class Input:
            closed = False
            def write(self, value):
                pass
            def flush(self):
                pass
            def close(self):
                self.closed = True
        class Process:
            def __init__(self):
                self.stdin, self.stderr, self.status = Input(), io.BytesIO(), None
            def wait(self, timeout=None):
                self.status = 0
                return 0
            def poll(self):
                return self.status
        class Control:
            image = "base-image"
            def __init__(self): self.lines = ["LOCKED", result_line]
            def helper_args(self, script, name=None):
                return ["docker", "run", "--network", "none", self.image, "--entrypoint", script]
            def _line(self, process): return self.lines.pop(0)

        control = Control()
        proof = {"record": record, "control": control, "store_root": "/state/store",
                 "ledger_mount": "type=volume,src=ledger,dst=/ledger,readonly,volume-nocopy"}
        process = Process()
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value="a" * 64), \
                patch.object(quarantine.subprocess, "Popen", return_value=process), \
                patch.object(quarantine, "_revalidate_external", side_effect=[[frontend], []]), \
                patch.object(quarantine, "_pair_presence", return_value=[frontend]), \
                patch.object(quarantine, "docker_capture", return_value=_completed()) as docker:
            quarantine._apply_transaction(proof)
        rm_calls = [(call.args, call.kwargs) for call in docker.call_args_list
                    if call.args and call.args[0] == "rm"]
        self.assertEqual(rm_calls, [(("rm", frontend), {"timeout": 90})])

        control = Control()
        process = Process()
        proof["control"] = control
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value="a" * 64), \
                patch.object(quarantine.subprocess, "Popen", return_value=process), \
                patch.object(quarantine, "_revalidate_external", return_value=[backend]), \
                patch.object(quarantine, "_pair_presence", return_value=[]), \
                patch.object(quarantine, "docker_capture", return_value=_completed()) as docker:
            with self.assertRaises(quarantine.BuildControlError):
                quarantine._apply_transaction(proof)
        self.assertFalse(any(call.args and call.args[0] == "rm" for call in docker.call_args_list))


if __name__ == "__main__":
    unittest.main()
