"""Interpreted safety regressions for explicit cancelled-activation drain."""

from __future__ import annotations

import ast
import argparse
from copy import deepcopy
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import tempfile
import uuid
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
module = importlib.import_module("docker_volume_cancelled_activation")
cancelled_guard = importlib.import_module("docker_volume_cancelled_activation_guard")
docker_dev = importlib.import_module("docker_dev")
from docker_build_control import ControlOutcomeUnknown, canonical
from docker_volume_dev import _cancelled_activation_probe_script, _retained_startup_enabled


ATTEMPT = "a" * 32
PREVIOUS_ATTEMPT = "b" * 32
DEV_ATTEMPT = "c" * 32
ITERATION_ATTEMPT = "d" * 32
CONFIG = "e" * 64
SOURCE_SHA = "f" * 64
REQUEST = "fdm:cpu-docker-cancelled-activation"
RUN_ID = "run-" + "1" * 40
TASK_ID = "task-" + "2" * 40
SUCCESS_TASK_ID = "task-" + "8" * 40
CANCELLATION_ID = "cancel-" + "3" * 40
BACKEND = "4" * 64
FRONTEND = "5" * 64
IMAGE = "sha256:" + "6" * 64
HELPER = "7" * 64
STATE_ROOT = "/state/fullmag"


class FakeControl:
    project = "fullmag-worktree-test"
    volume = "fullmag-worktree-test-control"
    namespace = ""
    identity = {"project_name": project}


def _owner(*, state: str, child_status: str) -> dict[str, object]:
    return {
        "schema_version": "runtime_service_owner.v1",
        "protocol": "stdin-v1",
        "state": state,
        "target_id": "docker-all",
        "owner_token": "owner-token-1",
        "process_start_token": "process-start-1",
        "pid": 100,
        "host": "backend",
        "control_address": "unix:///run/fullmag/control.sock",
        "build_commit": "a" * 40,
        "build_snapshot": "b" * 64,
        "compute_pool_id": "compute-pool-1",
        "preparation_pool_id": "preparation-pool-1",
        "compute_pool_generation": 1,
        "preparation_pool_generation": 1,
        "acquired_at": "2026-10-25T10:00:00Z",
        "heartbeat_at": "2026-10-25T10:00:01Z",
        "children": [
            {"role": "compute", "pid": 101, "status": child_status},
            {"role": "preparation", "pid": 102, "status": child_status},
        ],
    }


def _ready_process() -> dict[str, object]:
    return {
        "schema": module.PROCESS_RECEIPT_SCHEMA,
        "state": "ready",
        "service_owner": _owner(state="ready", child_status="running"),
    }


def _probe(**overrides: object) -> dict[str, object]:
    exit_path = "preparation_process_exit_receipts/prep-exit-launch-1.json"
    lease_path = "preparation_resource_leases/resource-1/lease-1.json"
    launch_path = "preparation_process_launches/launch-1.json"
    task_path = "task_preparation_receipts/" + SUCCESS_TASK_ID + ".json"
    stage_path = "accepted_stage_preparation_receipts/" + SUCCESS_TASK_ID + ".json"
    success_exit_path = "preparation_process_exit_receipts/prep-exit-launch-2.json"
    success_lease_path = "preparation_resource_leases/resource-2/lease-2.json"
    success_launch_path = "preparation_process_launches/launch-2.json"
    hashes = {path: str(index) * 64 for index, path in enumerate(
        (exit_path, launch_path, lease_path, task_path, stage_path,
         success_exit_path, success_launch_path, success_lease_path), start=1
    )}
    task_inventory = [
        {"task_id": TASK_ID, "input_fingerprint": "a" * 64, "lifecycle": "cancelled",
         "readiness": {"state": "blocked", "reason": "accepted_task_awaiting_preparation"}, "artifact_ids": []},
        {"task_id": SUCCESS_TASK_ID, "input_fingerprint": "b" * 64, "lifecycle": "cancelled",
         "readiness": {"state": "blocked", "reason": "awaiting dependency resolution"}, "artifact_ids": []},
    ]
    preparation_inventory = [
        {
            "task_id": TASK_ID, "outcome": "failed", "launch_id": "launch-1",
            "preparation_attempt_id": "prep-attempt-1", "resource_id": "resource-1",
            "lease_token": "lease-1", "launch_path": launch_path,
            "launch_sha256": hashes[launch_path], "exit_path": exit_path,
            "exit_sha256": hashes[exit_path], "lease_path": lease_path,
            "lease_sha256": hashes[lease_path], "lease_heartbeat_sequence": 6,
            "exit_code": 1, "timed_out": False, "lease_state": "released",
            "released_at": "2026-10-25T10:03:00Z", "task_receipt_path": None,
            "task_receipt_sha256": None, "stage_receipt_path": None,
            "stage_receipt_sha256": None,
        },
        {
            "task_id": SUCCESS_TASK_ID, "outcome": "succeeded", "launch_id": "launch-2",
            "preparation_attempt_id": "prep-attempt-2", "resource_id": "resource-2",
            "lease_token": "lease-2", "launch_path": success_launch_path,
            "launch_sha256": hashes[success_launch_path], "exit_path": success_exit_path,
            "exit_sha256": hashes[success_exit_path], "lease_path": success_lease_path,
            "lease_sha256": hashes[success_lease_path], "lease_heartbeat_sequence": 7,
            "exit_code": 0, "timed_out": False, "lease_state": "released",
            "released_at": "2026-10-25T10:04:00Z", "task_receipt_path": task_path,
            "task_receipt_sha256": hashes[task_path], "stage_receipt_path": stage_path,
            "stage_receipt_sha256": hashes[stage_path],
        },
    ]
    probe: dict[str, object] = {
        "schema": "fullmag.docker-activation-cancel-probe.v1",
        "run_id": RUN_ID,
        "task_id": TASK_ID,
        "request_id": REQUEST,
        "source_sha256": SOURCE_SHA,
        "catalog_revision": 3,
        "cancellation_id": CANCELLATION_ID,
        "run_intent_sha256": "8" * 64,
        "run_catalog_sha256": "9" * 64,
        "cancellation_intent_sha256": "a" * 64,
        "activation_marker_sha256": "b" * 64,
        "matching_reservations": 0,
        "task_count": 2,
        "task_inventory": task_inventory,
        "live_api_instance_id": "api-instance-1",
        "live_session_id": "session-1",
        "live_session_epoch": 2,
        "live_scene_revision": 5,
        "live_workspace_sha256": "c" * 64,
        "retained_current_run_sha256": "d" * 64,
        "retained_current_run_task_count": 2,
        "compute_queue": {"items": []},
        "runtime_service": {"configured": True, "state": "ready"},
        "health": {"status": "ok", "active_session": True},
        "preparation_evidence": [
            {"path": path, "sha256": hashes[path]}
            for path in sorted(hashes)
        ],
        "preparation_inventory": preparation_inventory,
        "preparation_host_reservations": [],
        "failed_preparation": {
            "launch_id": "launch-1",
            "preparation_attempt_id": "prep-attempt-1",
            "resource_id": "resource-1",
            "lease_token": "lease-1",
            "exit_receipt_path": exit_path,
            "exit_receipt_sha256": hashes[exit_path],
            "lease_path": lease_path,
            "lease_sha256": hashes[lease_path],
            "lease_heartbeat_sequence": 6,
            "status_success": False,
            "exit_code": 1,
            "timed_out": False,
            "lease_state": "released",
            "released_at": "2026-10-25T10:03:00Z",
        },
    }
    probe.update(overrides)
    return probe


def _cancel_before_start_probe() -> dict[str, object]:
    probe = _probe()
    probe["preparation_inventory"] = deepcopy(probe["preparation_inventory"])
    assert isinstance(probe["preparation_inventory"], list)
    failed = probe["preparation_inventory"][0]
    assert isinstance(failed, dict)
    failed.update({
        "outcome": "succeeded",
        "exit_code": 0,
        "task_receipt_path": f"task_preparation_receipts/{TASK_ID}.json",
        "task_receipt_sha256": "1" * 64,
        "stage_receipt_path": f"accepted_stage_preparation_receipts/{TASK_ID}.json",
        "stage_receipt_sha256": "2" * 64,
    })
    evidence = list(probe["preparation_evidence"])
    assert isinstance(evidence, list)
    evidence.extend([
        {"path": failed["task_receipt_path"], "sha256": failed["task_receipt_sha256"]},
        {"path": failed["stage_receipt_path"], "sha256": failed["stage_receipt_sha256"]},
    ])
    probe.update({
        "preparation_mode": module.CANCEL_BEFORE_START_MODE,
        "start_release_absent": True,
        "task_admissions_empty": True,
        "execution_state": "not-started",
        "retained_current_run_total_steps": 2,
        "artifact_catalog_present": False,
        "artifact_catalog_entry_count": 0,
        "preparation_evidence": sorted(evidence, key=lambda item: item["path"]),
    })
    probe.pop("failed_preparation")
    return probe


def _proof(control: FakeControl | None = None) -> dict[str, object]:
    control = control or FakeControl()
    process = _ready_process()
    process_raw = canonical(process) + b"\n"
    receipt = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "activation",
        "attempt": ATTEMPT,
        "state": "outcome-unknown-resources-retained",
        "helper_container": "fullmag-control-" + ATTEMPT,
        "inputs": {},
    }
    receipt_raw = canonical(receipt) + b"\n"
    current_raw = canonical({"attempt": PREVIOUS_ATTEMPT}) + b"\n"
    result_raw = canonical({"attempt": ATTEMPT, "result": "unknown"}) + b"\n"
    return {
        "selected": "/repo/worktree",
        "identity": {"project_name": control.project},
        "control": control,
        "config_sha256": CONFIG,
        "previous": {"attempt": DEV_ATTEMPT},
        "pin": {"attempt": ITERATION_ATTEMPT, "phase": "iteration"},
        "state_root": STATE_ROOT,
        "image_id": IMAGE,
        "backend": {"Id": BACKEND},
        "frontend": {"Id": FRONTEND},
        "backend_container": BACKEND,
        "frontend_container": FRONTEND,
        "backend_started_at": "2026-10-25T09:00:00.000000000Z",
        "frontend_started_at": "2026-10-25T09:00:01.000000000Z",
        "receipt": receipt,
        "receipt_raw": receipt_raw,
        "receipt_sha256": hashlib.sha256(receipt_raw).hexdigest(),
        "retirement_context": {"run_id": RUN_ID, "session_id": "session-1"},
        "helper_id": HELPER,
        "active_raw": ATTEMPT.encode("ascii"),
        "result_raw": result_raw,
        "current_raw": current_raw,
        "terminal_path": "activation/attempts/" + ATTEMPT + "/terminal.json",
        "process_raw": process_raw,
        "process": process,
        "ready_owner": process["service_owner"],
        "ready_owner_identity_sha256": module._identity_hash(process["service_owner"]),
        "request_id": REQUEST,
        "source_sha256": SOURCE_SHA,
        "cancellation": {
            "run_id": RUN_ID,
            "session_id": "session-1",
            "task_id": TASK_ID,
            "cancellation_id": CANCELLATION_ID,
            "request_id": REQUEST,
            "source_sha256": SOURCE_SHA,
            "activation_marker_sha256": "b" * 64,
        },
    }


def _args(
    proof: dict[str, object], *, digest: str | None = None, base_development: bool = False,
) -> argparse.Namespace:
    plan = module._plan(proof)
    return argparse.Namespace(
        attempt=DEV_ATTEMPT,
        iteration_attempt=None if base_development else ITERATION_ATTEMPT,
        base_development=base_development,
        activation_attempt=ATTEMPT,
        config_sha256=CONFIG,
        port=3198,
        apply=True,
        expected_plan_sha256=digest or plan["plan_sha256"],
    )


def _drained_receipt(proof: dict[str, object]) -> tuple[bytes, dict[str, object]]:
    ready_owner = proof["ready_owner"]
    receipt = {
        "schema": module.PROCESS_RECEIPT_SCHEMA,
        "state": "drained",
        "service_owner": ready_owner,
        "terminal_service_owner": _owner(state="drained", child_status="exited_success"),
    }
    return canonical(receipt) + b"\n", receipt


class CancelledActivationProofTests(unittest.TestCase):
    def test_failed_probe_script_is_read_only_strict_and_does_not_change_baseline(self) -> None:
        baseline = _cancelled_activation_probe_script()
        generated = module._failed_preparation_probe_script()
        self.assertEqual(_cancelled_activation_probe_script(), baseline)
        ast.parse(generated)
        self.assertIn('process_exit.get("status_success") is not False', generated)
        self.assertIn('process_exit.get("exit_code")!=1', generated)
        self.assertIn('process_exit.get("timed_out") is not False', generated)
        self.assertIn('prep_lease["state"]', generated)
        self.assertIn('prep_lease["released_at"]', generated)
        self.assertIn("if task_receipts or stage_receipts:", generated)
        self.assertIn("launch_heartbeat>exit_heartbeat or exit_heartbeat!=lease_heartbeat", generated)
        self.assertIn('retained_run.get("total_steps")!=len(tasks)', generated)
        self.assertNotIn('retained_run.get("solver_steps")', generated)
        for forbidden in ("requests.post", "os.unlink(", "os.remove(", "os.rename("):
            self.assertNotIn(forbidden, generated)
        ast.parse(module._scope_discovery_script())

    def test_embedded_catalog_rejects_owner_state_and_unknown_task_fields(self) -> None:
        generated = module._failed_preparation_probe_script()
        start = generated.index('    tasks=catalog.get("tasks")')
        end = generated.index('    if cancellation.get("schema_version")', start)
        catalog_block = textwrap.dedent(generated[start:end])

        class ProbeRejected(RuntimeError):
            pass

        def run(task: dict[str, object]) -> None:
            def fail(message: str) -> None:
                raise ProbeRejected(message)

            namespace = {
                "catalog": {"tasks": [task]},
                "task_id": "task-catalog-test",
                "is_sha": lambda value: isinstance(value, str) and len(value) == 64,
                "fail": fail,
            }
            exec(catalog_block, namespace, namespace)

        valid = {
            "task_id": "task-catalog-test",
            "input_fingerprint": "a" * 64,
            "lifecycle": "cancelled",
            "readiness": {"state": "blocked", "reason": "awaiting preparation"},
            "artifact_ids": [],
        }
        run({**valid, "observation": None, "ownership_epoch": None})
        with self.assertRaises(ProbeRejected):
            run({**valid, "ownership_epoch": 7})
        with self.assertRaises(ProbeRejected):
            run({**valid, "future_task_field": None})

    def test_failed_exit_and_released_exact_lease_are_required(self) -> None:
        accepted = module._validate_failed_preparation_probe(
            _probe(), request_id=REQUEST, source_sha256=SOURCE_SHA,
            expected_run_id=RUN_ID, expected_session_id="session-1",
        )
        self.assertEqual(accepted["failed_preparation"]["exit_code"], 1)
        self.assertEqual(accepted["failed_preparation"]["lease_state"], "released")
        for changes in (
            {"request_id": "another-request"},
            {"source_sha256": "0" * 64},
            {"run_id": "run-foreign"},
            {"live_session_id": "session-foreign"},
            {"failed_preparation": {**_probe()["failed_preparation"], "status_success": True}},
            {"failed_preparation": {**_probe()["failed_preparation"], "exit_code": 0}},
            {"failed_preparation": {**_probe()["failed_preparation"], "timed_out": True}},
            {"failed_preparation": {**_probe()["failed_preparation"], "lease_state": "active"}},
            {"matching_reservations": 1},
            {"retained_current_run_task_count": 0},
            {"compute_queue": {"items": [{"state": "queued"}]}},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(module.CancelledActivationRecoveryError):
                    module._validate_failed_preparation_probe(
                        _probe(**changes), request_id=REQUEST, source_sha256=SOURCE_SHA,
                        expected_run_id=RUN_ID, expected_session_id="session-1",
                    )

    def test_multi_task_inventory_is_exact_and_fail_closed(self) -> None:
        reordered = _probe()
        reordered["task_inventory"] = list(reversed(reordered["task_inventory"]))
        reordered["preparation_inventory"] = list(reversed(reordered["preparation_inventory"]))
        accepted = module._validate_failed_preparation_probe(
            reordered, request_id=REQUEST, source_sha256=SOURCE_SHA,
            expected_run_id=RUN_ID, expected_session_id="session-1",
        )
        self.assertEqual(accepted["probe"]["task_count"], 2)
        self.assertEqual(accepted["failed_preparation"]["launch_id"], "launch-1")
        self.assertEqual(
            {entry["task_id"] for entry in accepted["task_inventory"]},
            {TASK_ID, SUCCESS_TASK_ID},
        )
        base = _probe()
        variants = []
        duplicate_tasks = list(base["task_inventory"])
        duplicate_tasks[1] = {**duplicate_tasks[1], "task_id": TASK_ID}
        variants.append({"task_inventory": duplicate_tasks})
        variants.append({
            "task_inventory": [
                base["task_inventory"][0],
                {**base["task_inventory"][1], "input_fingerprint": "not-a-sha"},
            ],
        })
        variants.append({
            "task_inventory": [
                base["task_inventory"][0],
                {**base["task_inventory"][1], "lifecycle": "succeeded"},
            ],
        })
        variants.append({
            "task_inventory": [
                base["task_inventory"][0],
                {**base["task_inventory"][1], "artifact_ids": ["artifact-output"]},
            ],
        })
        orphan_lease = list(base["preparation_inventory"])
        orphan_lease[0] = {**orphan_lease[0], "lease_path": "preparation_resource_leases/unknown/lease.json"}
        variants.append({"preparation_inventory": orphan_lease})
        duplicate_preparations = list(base["preparation_inventory"])
        duplicate_preparations[1] = {
            **duplicate_preparations[1], "task_id": TASK_ID,
        }
        variants.append({"preparation_inventory": duplicate_preparations})
        unknown_evidence = list(base["preparation_evidence"])
        unknown_evidence.append({"path": "preparation_process_launches/unknown.json", "sha256": "8" * 64})
        variants.append({"preparation_evidence": unknown_evidence})
        for changes in variants:
            with self.subTest(changes=changes):
                with self.assertRaises(module.CancelledActivationRecoveryError):
                    module._validate_failed_preparation_probe(
                        _probe(**changes), request_id=REQUEST, source_sha256=SOURCE_SHA,
                        expected_run_id=RUN_ID, expected_session_id="session-1",
                    )

    def test_heartbeat_changes_are_excluded_but_marker_and_scope_are_pinned(self) -> None:
        first = _probe()
        second = _probe(heartbeat_at="later", host_ledger_sha256="different")
        stable_first = module._stable_store_probe(first)
        stable_second = module._stable_store_probe(second)
        self.assertEqual(stable_first, stable_second)
        changed = _probe(activation_marker_sha256="c" * 64)
        cancellation = module._validate_failed_preparation_probe(
            changed, request_id=REQUEST, source_sha256=SOURCE_SHA,
        )
        self.assertNotEqual(
            module._plan(dict(_proof(), cancellation=cancellation))["plan_sha256"],
            module._plan(_proof())["plan_sha256"],
        )

    def test_cancel_before_start_accepts_only_explicit_complete_all_success_proof(self) -> None:
        accepted = module._validate_cancel_before_start_probe(
            _cancel_before_start_probe(),
            request_id=REQUEST,
            source_sha256=SOURCE_SHA,
            expected_run_id=RUN_ID,
            expected_session_id="session-1",
        )
        self.assertEqual(accepted["preparation_mode"], module.CANCEL_BEFORE_START_MODE)
        self.assertTrue(accepted["start_release_absent"])
        self.assertEqual(accepted["retained_current_run_total_steps"], 2)
        present_empty_catalog = _cancel_before_start_probe()
        present_empty_catalog.update({
            "artifact_catalog_present": True,
            "artifact_catalog_sha256": "e" * 64,
        })
        catalog_accepted = module._validate_cancel_before_start_probe(
            present_empty_catalog, request_id=REQUEST, source_sha256=SOURCE_SHA,
        )
        self.assertEqual(catalog_accepted["artifact_catalog_sha256"], "e" * 64)
        proof = dict(_proof(), cancellation=accepted)
        plan = module._plan(proof)
        self.assertEqual(plan["target"]["cancellation_mode"], module.CANCEL_BEFORE_START_MODE)
        journal = module._initial_journal(_args(proof), proof, plan, proof["control"])
        self.assertEqual(
            journal["plan"]["target"]["cancellation_mode"], module.CANCEL_BEFORE_START_MODE,
        )
        recovery = module._record_from_journal({
            **journal,
            "state": "drain-confirmed",
            "drain": {"backend_exit_code": 0},
        })
        self.assertEqual(recovery["cancellation_mode"], module.CANCEL_BEFORE_START_MODE)
        self.assertTrue(recovery["start_release_absent"])

        mutations = (
            {"preparation_mode": None},
            {"start_release_absent": False},
            {"task_admissions_empty": False},
            {"retained_current_run_total_steps": 1},
            {"matching_reservations": 1},
            {"compute_queue": {"items": ["queued"]}},
            {"failed_preparation": {}},
            {"artifact_catalog_entry_count": 1},
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                candidate = _cancel_before_start_probe()
                candidate.update(mutation)
                with self.assertRaises(module.CancelledActivationRecoveryError):
                    module._validate_cancel_before_start_probe(
                        candidate, request_id=REQUEST, source_sha256=SOURCE_SHA,
                    )

        missing_receipt = _cancel_before_start_probe()
        assert isinstance(missing_receipt["preparation_inventory"], list)
        missing_receipt["preparation_inventory"][0]["task_receipt_path"] = None
        missing_receipt["preparation_inventory"][0]["task_receipt_sha256"] = None
        with self.assertRaises(module.CancelledActivationRecoveryError):
            module._validate_cancel_before_start_probe(
                missing_receipt, request_id=REQUEST, source_sha256=SOURCE_SHA,
            )

    def test_cancel_before_start_probe_is_distinct_and_checks_no_start_reachability(self) -> None:
        source = module._cancel_before_start_probe_script()
        ast.parse(source)
        self.assertIn('start_release=run/"start_release.json"', source)
        self.assertIn('probe["preparation_mode"]="cancel-before-start"', source)
        self.assertIn("cancel-before-start retained run task count differs from its catalogue", source)
        self.assertIn('resource lease identity differs from its canonical path', source)
        self.assertIn('cancel-before-start run retains a solver lease', source)
        self.assertIn('value.get("schema_version")!="resource_lease.v1"', source)
        self.assertIn('if row.get("state")!="released":', source)
        self.assertIn('cancel-before-start host reservation targets an unknown task', source)
        self.assertIn('artifact_catalog_path=run/"artifact_catalog.json"', source)
        self.assertIn('artifact_catalog.get("entries")!=[]', source)
        self.assertNotIn(
            'value.get("task_id") in task_ids and value.get("state")!="released"', source,
        )
        self.assertNotEqual(source, module._failed_preparation_probe_script())

    def test_embedded_cancel_before_start_rejects_solver_lease_history(self) -> None:
        source = module._cancel_before_start_probe_script()
        start = source.index('    solver_root=run/"resource_leases"')
        end = source.index('    ledger_raw=', start)
        block = textwrap.dedent(source[start:end])

        def reject(message: str) -> None:
            raise module.CancelledActivationRecoveryError(message)

        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            namespace = {
                "run": run, "run_id": RUN_ID, "os": os,
                "pathlib": importlib.import_module("pathlib"), "uuid": uuid,
                "fail": reject,
                "regular": lambda path, label: path.read_bytes(),
                "strict_obj": lambda raw, label: json.loads(raw),
            }
            exec(block, namespace, namespace)
            self.assertEqual(namespace["solver_matches"], [])
            lease = run / "resource_leases" / "resource-1" / "lease-1.json"
            lease.parent.mkdir(parents=True)
            base = {
                "schema_version": "resource_lease.v1", "run_id": RUN_ID,
                "resource_id": "resource-1", "lease_token": "lease-1",
                "task_id": TASK_ID, "state": "released",
            }
            for change in ({}, {"state": "active"}, {"task_id": "orphan-task"}):
                with self.subTest(change=change):
                    lease.write_text(json.dumps({**base, **change}))
                    with self.assertRaisesRegex(
                        module.CancelledActivationRecoveryError, "retains a solver lease",
                    ):
                        exec(block, namespace, namespace)
            lease.unlink()
            staging = lease.parent / ("." + str(uuid.uuid4()) + ".part")
            staging.write_text("partial atomic write")
            exec(block, namespace, namespace)
            staging.unlink()
            staging.symlink_to(run / "absent")
            with self.assertRaisesRegex(
                module.CancelledActivationRecoveryError, "lease entry is invalid",
            ):
                exec(block, namespace, namespace)
            staging.unlink()
            root_staging = lease.parent.parent / ("." + str(uuid.uuid4()) + ".part")
            root_staging.write_text("not canonical at the resource_leases root")
            with self.assertRaises(module.CancelledActivationRecoveryError):
                exec(block, namespace, namespace)
            root_staging.unlink()
            invalid_resource = lease.parent.parent / "bad resource name"
            invalid_resource.mkdir()
            with self.assertRaisesRegex(module.CancelledActivationRecoveryError, "directory is not canonical"):
                exec(block, namespace, namespace)
            invalid_resource.rmdir()

            def unreadable(root: object, **options: object) -> object:
                options["onerror"](PermissionError("fixture traversal denied"))
                return iter(())

            with patch.object(os, "walk", side_effect=unreadable):
                with self.assertRaisesRegex(module.CancelledActivationRecoveryError, "tree cannot be read"):
                    exec(block, namespace, namespace)

    def test_embedded_cancel_before_start_classifies_every_host_owner_for_run(self) -> None:
        tree = ast.parse(module._cancel_before_start_probe_script())
        loops = [node for node in ast.walk(tree)
                 if isinstance(node, ast.For) and isinstance(node.target, ast.Name)
                 and node.target.id == "row" and isinstance(node.iter, ast.Name)
                 and node.iter.id == "reservations"]
        self.assertEqual(len(loops), 1)
        block = compile(ast.Module(body=loops, type_ignores=[]), "host-owner-probe", "exec")

        def reject(message: str) -> None:
            raise module.CancelledActivationRecoveryError(message)

        def run(row: dict[str, object]) -> list[object]:
            namespace = {
                "reservations": [row], "run_id": RUN_ID, "task_ids": {TASK_ID},
                "matching": [], "fail": reject,
            }
            exec(block, namespace, namespace)
            return namespace["matching"]

        for state in ("released", "active"):
            with self.subTest(state=state):
                with self.assertRaisesRegex(
                    module.CancelledActivationRecoveryError, "unknown task",
                ):
                    run({"identity": {"run_id": RUN_ID, "task_id": "orphan-task"},
                         "state": state})
        active = {"identity": {"run_id": RUN_ID, "task_id": TASK_ID}, "state": "active"}
        self.assertEqual(run(active), [active])
        self.assertEqual(run({"identity": {"run_id": "foreign-run", "task_id": "foreign-task"},
                              "state": "active"}), [])

    def test_embedded_cancel_before_start_checks_authoritative_artifact_catalog(self) -> None:
        source = module._cancel_before_start_probe_script()
        start = source.index('    artifact_catalog_path=run/"artifact_catalog.json"')
        end = source.index('    scene, _, _ = api_get(', start)
        block = textwrap.dedent(source[start:end])

        def reject(message: str) -> None:
            raise module.CancelledActivationRecoveryError(message)

        with tempfile.TemporaryDirectory() as temporary:
            namespace = {
                "run": Path(temporary), "run_id": RUN_ID, "fail": reject,
                "regular": lambda path, label: path.read_bytes(),
                "strict_obj": lambda raw, label: json.loads(raw),
                "digest": lambda raw: hashlib.sha256(raw).hexdigest(),
            }
            exec(block, namespace, namespace)
            self.assertFalse(namespace["artifact_catalog_present"])
            catalog = Path(temporary) / "artifact_catalog.json"
            base = {"schema_version": "artifact_catalog.v1", "run_id": RUN_ID,
                    "revision": 1, "updated_at": "2026-10-29T10:00:00Z", "entries": []}
            catalog.write_text(json.dumps(base))
            exec(block, namespace, namespace)
            self.assertTrue(namespace["artifact_catalog_present"])
            self.assertEqual(namespace["artifact_catalog_sha256"],
                             hashlib.sha256(catalog.read_bytes()).hexdigest())
            # Even an empty projected task artifact_ids cannot hide a durable catalog entry.
            for change in ({"entries": [{"artifact_id": "retained-output"}]},
                           {"run_id": "foreign-run"}, {"revision": 0},
                           {"revision": True}, {"entries": None},
                           {"updated_at": "not-a-timestamp"},
                           {"updated_at": "2026-02-30T10:00:00Z"},
                           {"updated_at": "2026-10-29T10:00:00"}):
                with self.subTest(change=change):
                    catalog.write_text(json.dumps({**base, **change}))
                    with self.assertRaisesRegex(
                        module.CancelledActivationRecoveryError, "canonical artifact catalog",
                    ):
                        exec(block, namespace, namespace)

    def test_ready_receipt_is_explicit_activation_with_startup_disabled(self) -> None:
        process = _ready_process()
        module._validate_original_process(process)
        self.assertEqual(_retained_startup_enabled({"Config": {"Env": []}}), False)
        self.assertEqual(
            module._explicit_activation_environment({"services": {"backend": {"environment": {}}}}),
            {},
        )
        for bad_process in (
            {**process, "startup_activation": {"state": "unknown"}},
            {**process, "state": "drained"},
            {**process, "terminal_service_owner": {}},
        ):
            with self.subTest(bad_process=bad_process):
                with self.assertRaises(module.CancelledActivationRecoveryError):
                    module._validate_original_process(bad_process)
        for environment in (None, "1", "invalid"):
            with self.subTest(environment=environment):
                with self.assertRaises(module.CancelledActivationRecoveryError):
                    module._explicit_activation_environment({
                        "services": {"backend": {"environment": {
                            "FULLMAG_STARTUP_ENABLED": environment,
                        }}}
                    })
        with self.assertRaises(Exception):
            _retained_startup_enabled({"Config": {"Env": ["FULLMAG_STARTUP_ENABLED=invalid"]}})

    def test_base_development_pin_has_no_fictional_iteration(self) -> None:
        proof = dict(_proof(), pin={"attempt": DEV_ATTEMPT, "phase": "development"})
        cancellation = module._validate_failed_preparation_probe(
            _probe(), request_id=REQUEST, source_sha256=SOURCE_SHA,
        )
        proof["cancellation"] = cancellation
        plan = module._plan(proof)
        self.assertIsNone(plan["target"]["iteration_attempt"])
        self.assertEqual(plan["target"]["continuation_phase"], "development")
        self.assertEqual(plan["target"]["continuation_attempt"], DEV_ATTEMPT)
        args = _args(proof, base_development=True)
        journal = module._initial_journal(args, proof, plan, proof["control"])
        with patch.object(module, "_read_pinned_original_records", return_value={
            "receipt": proof["receipt"], "receipt_raw": proof["receipt_raw"],
            "result_raw": proof["result_raw"], "activation_current_raw": proof["current_raw"],
            "activation_terminal_raw": None,
        }), patch.object(module, "_read_control_bytes", return_value=proof["active_raw"]):
            resumed = module._proof_from_journal(
                args, proof["selected"], proof["identity"], proof["control"], journal,
            )
        self.assertEqual(resumed["pin"], {"attempt": DEV_ATTEMPT, "phase": "development"})

    def test_cancelled_activation_parser_requires_exactly_one_continuation_pin(self) -> None:
        parser = docker_dev._parser()
        common = [
            "recover-cancelled-activation", "--attempt", DEV_ATTEMPT,
            "--activation-attempt", ATTEMPT, "--config-sha256", CONFIG,
            "--source-root", "/repo/worktree", "--port", "3198",
        ]
        parsed = parser.parse_args([*common, "--base-development"])
        self.assertTrue(parsed.base_development)
        self.assertIsNone(parsed.iteration_attempt)
        parsed = parser.parse_args([*common, "--iteration-attempt", ITERATION_ATTEMPT])
        self.assertFalse(parsed.base_development)
        self.assertEqual(parsed.iteration_attempt, ITERATION_ATTEMPT)
        parsed = parser.parse_args([
            *common, "--base-development", "--cancellation-mode", "cancel-before-start",
        ])
        self.assertEqual(parsed.cancellation_mode, "cancel-before-start")
        with self.assertRaises(SystemExit):
            parser.parse_args([*common])
        with self.assertRaises(SystemExit):
            parser.parse_args([
                *common, "--base-development", "--iteration-attempt", ITERATION_ATTEMPT,
            ])

    def test_selected_context_accepts_base_or_iteration_without_swapping_the_guard(self) -> None:
        configured = {
            "services": {
                "fem-gpu-toolchain": {
                    "build": {"args": {"FULLMAG_CUDA_BASE_IMAGE": "image:pin"}},
                },
            },
        }
        for iteration_attempt, base_development in (
            (None, True),
            (ITERATION_ATTEMPT, False),
        ):
            with self.subTest(iteration_attempt=iteration_attempt), \
                    patch.object(module, "_resolve_selected", return_value=(
                        "/repo/worktree", None, {"project_name": "fullmag-worktree-test"}
                    )), \
                    patch.object(module, "toolchain_configuration", return_value=configured), \
                    patch.object(module, "BuildControl", return_value=FakeControl()), \
                    patch.object(module, "_validate_existing_control_volume"):
                selected, _identity, _control = module._selected_context(argparse.Namespace(
                    attempt=DEV_ATTEMPT,
                    iteration_attempt=iteration_attempt,
                    base_development=base_development,
                    activation_attempt=ATTEMPT,
                    config_sha256=CONFIG,
                    port=3198,
                    source_root="/repo/worktree",
                ))
                self.assertEqual(selected, "/repo/worktree")

    def test_base_development_terminal_pin_rejects_iteration_impersonation(self) -> None:
        previous = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "succeeded",
            "attempt": DEV_ATTEMPT,
            "compose_project": FakeControl.project,
            "control_volume": FakeControl.volume,
            "config_sha256": CONFIG,
            "state_root": STATE_ROOT,
            "inputs": {
                "attempt": DEV_ATTEMPT,
                "config_sha256": CONFIG,
                "source_root": "/repo/worktree",
                "image_id": IMAGE,
            },
            "backend_container": BACKEND,
            "frontend_container": FRONTEND,
            "backend_started_at": "2026-10-25T09:00:00.000000000Z",
            "frontend_started_at": "2026-10-25T09:00:01.000000000Z",
            "worker_cgroup": {
                "schema": "fullmag.worker-cgroup-ready.v1",
                "compose_project": FakeControl.project,
                "container_id": BACKEND,
                "image_id": IMAGE,
                "state": "ready",
                "root": "/opt/fullmag/worker-cgroup",
            },
        }
        pin = module._validate_base_development_pin(
            FakeControl(), previous, development_attempt=DEV_ATTEMPT,
            config_sha256=CONFIG, source_root="/repo/worktree",
        )
        self.assertEqual(pin["phase"], "development")
        self.assertEqual(pin["attempt"], DEV_ATTEMPT)
        self.assertEqual(pin["backend_container"], BACKEND)
        with self.assertRaises(module.CancelledActivationRecoveryError):
            module._validate_base_development_pin(
                FakeControl(), {**previous, "state": "iteration"},
                development_attempt=DEV_ATTEMPT, config_sha256=CONFIG,
                source_root="/repo/worktree",
            )

    def test_drain_requires_same_backend_and_all_native_children_successfully_exit(self) -> None:
        proof = _proof()
        stopped = {
            "Id": BACKEND,
            "Image": IMAGE,
            "State": {
                "StartedAt": proof["backend_started_at"],
                "FinishedAt": "2026-10-25T10:00:00Z",
                "Running": False,
                "OOMKilled": False,
                "ExitCode": 0,
            },
        }
        raw, terminal_receipt = _drained_receipt(proof)
        accepted = module._validate_drain(
            stopped, raw, terminal_receipt, proof=proof, ready_owner=proof["ready_owner"],
        )
        self.assertEqual(accepted["native_children_exit_status"], "exited_success")
        for changes in (
            {"Id": "8" * 64},
            {"Image": "sha256:" + "9" * 64},
            {"State": {**stopped["State"], "StartedAt": "different"}},
            {"State": {**stopped["State"], "OOMKilled": True}},
            {"State": {**stopped["State"], "ExitCode": 1}},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(module.CancelledActivationRecoveryError):
                    module._validate_drain(
                        {**stopped, **changes}, raw, terminal_receipt,
                        proof=proof, ready_owner=proof["ready_owner"],
                    )
        bad_owner = _owner(state="drained", child_status="exited_success")
        bad_owner["children"][0]["status"] = "failed"
        bad_receipt = {**terminal_receipt, "terminal_service_owner": bad_owner}
        with self.assertRaises(module.CancelledActivationRecoveryError):
            module._validate_drain(stopped, raw, bad_receipt, proof=proof,
                                   ready_owner=proof["ready_owner"])

    def test_helper_active_lease_cannot_switch_operation_or_helper(self) -> None:
        control = FakeControl()
        with patch.object(module, "_read_control_bytes", return_value=ATTEMPT.encode("ascii")), \
             patch.object(module, "_read_control_record", return_value=({"helper_container": "helper"}, b"{}")), \
             patch.object(module, "_validate_helper", return_value=(None, HELPER)):
            self.assertEqual(module._validate_helper_and_active(
                control, ATTEMPT, expected_helper_id=HELPER, require_active=True,
            ), ATTEMPT.encode("ascii"))
        with patch.object(module, "_read_control_bytes", return_value=b"foreign"), \
             patch.object(module, "_read_control_record") as read_receipt:
            with self.assertRaises(ControlOutcomeUnknown):
                module._validate_helper_and_active(
                    control, ATTEMPT, expected_helper_id=HELPER, require_active=True,
                )
            read_receipt.assert_not_called()
        with patch.object(module, "_read_control_bytes", return_value=ATTEMPT.encode("ascii")), \
             patch.object(module, "_read_control_record", return_value=({"helper_container": "helper"}, b"{}")), \
             patch.object(module, "_validate_helper", return_value=(None, "8" * 64)):
            with self.assertRaises(ControlOutcomeUnknown):
                module._validate_helper_and_active(
                    control, ATTEMPT, expected_helper_id=HELPER, require_active=False,
                )

    def test_pre_stop_barrier_rejects_changed_marker_active_lease_and_current_pointer(self) -> None:
        proof = _proof()
        plan = module._plan(proof)
        variants = (
            dict(proof, cancellation={**proof["cancellation"], "activation_marker_sha256": "0" * 64}),
            dict(proof, active_raw=b"foreign"),
            dict(proof, current_raw=b"changed prior current pointer"),
            dict(proof, receipt_raw=b"changed receipt"),
        )
        for changed in variants:
            with self.subTest(changed=changed):
                with self.assertRaises(ControlOutcomeUnknown):
                    module._assert_pre_stop_barrier(proof, changed, plan)

    def test_journal_resume_reconstructs_flat_backend_and_frontend_pins(self) -> None:
        proof = _proof()
        args = _args(proof)
        plan = module._plan(proof)
        journal = module._initial_journal(args, proof, plan, proof["control"])
        original = {
            "receipt": proof["receipt"],
            "receipt_raw": proof["receipt_raw"],
            "result_raw": proof["result_raw"],
            "activation_current_raw": proof["current_raw"],
            "activation_terminal_raw": None,
        }
        with patch.object(module, "_read_pinned_original_records", return_value=original), \
             patch.object(module, "_read_control_bytes", return_value=proof["active_raw"]):
            resumed = module._proof_from_journal(
                args, proof["selected"], proof["identity"], proof["control"], journal,
            )
        self.assertEqual(resumed["backend_container"], BACKEND)
        self.assertEqual(resumed["frontend_container"], FRONTEND)
        self.assertEqual(resumed["backend_started_at"], proof["backend_started_at"])
        self.assertEqual(resumed["frontend_started_at"], proof["frontend_started_at"])

        legacy_target = dict(plan["target"])
        legacy_target.pop("continuation_phase")
        legacy_target.pop("continuation_attempt")
        legacy_plan = dict(plan, target=legacy_target)
        legacy_plan_body = dict(legacy_plan)
        legacy_plan_body.pop("plan_sha256")
        legacy_plan["plan_sha256"] = module._sha256(canonical(legacy_plan_body))
        legacy_journal = dict(journal, plan=legacy_plan)
        with patch.object(module, "_read_pinned_original_records", return_value=original), \
                patch.object(module, "_read_control_bytes", return_value=proof["active_raw"]):
            legacy_resumed = module._proof_from_journal(
                args, proof["selected"], proof["identity"], proof["control"], legacy_journal,
            )
        self.assertEqual(
            legacy_resumed["pin"], {"attempt": ITERATION_ATTEMPT, "phase": "iteration"}
        )

        legacy_base_target = dict(legacy_target)
        legacy_base_target.pop("iteration_attempt")
        legacy_base_plan = dict(legacy_plan, target=legacy_base_target)
        legacy_base_body = dict(legacy_base_plan)
        legacy_base_body.pop("plan_sha256")
        legacy_base_plan["plan_sha256"] = module._sha256(canonical(legacy_base_body))
        with patch.object(module, "_read_pinned_original_records", return_value=original), \
                patch.object(module, "_read_control_bytes", return_value=proof["active_raw"]), \
                self.assertRaises(module.CancelledActivationRecoveryError):
            module._proof_from_journal(
                args, proof["selected"], proof["identity"], proof["control"],
                dict(legacy_journal, plan=legacy_base_plan),
            )

    def test_journal_plan_digest_is_mandatory(self) -> None:
        proof = _proof()
        args = _args(proof)
        plan = module._plan(proof)
        journal = module._initial_journal(args, proof, plan, proof["control"])
        journal.pop("plan_sha256")
        with patch.object(module, "_preserve_original_records"):
            with self.assertRaises(module.CancelledActivationRecoveryError):
                module._validate_journal_pins(args, journal, proof, plan)

    def test_verified_prior_recovery_current_is_replaced_only_after_archive_proof(self) -> None:
        control = FakeControl()
        prior = canonical({
            "schema": module.RECOVERY_SCHEMA,
            "activation_attempt": PREVIOUS_ATTEMPT,
            "state": module.RECOVERY_STATE,
        }) + b"\n"
        prior_record = {"activation_attempt": PREVIOUS_ATTEMPT}
        with patch.object(module, "_read_control_bytes", return_value=prior), \
                patch.object(cancelled_guard, "read_record", return_value=prior_record), \
                patch.object(cancelled_guard, "has_archive", return_value=True), \
                patch.object(cancelled_guard, "pin_archive") as pin_archive:
            self.assertEqual(module._require_recovery_current_clear(control, ATTEMPT), prior)
            self.assertEqual(
                module._require_recovery_current_clear(
                    control, ATTEMPT, pin_existing_archive=True,
                ),
                prior,
            )
            pin_archive.assert_called_once_with(control)
        with patch.object(module, "_read_control_bytes", return_value=prior), \
                patch.object(cancelled_guard, "read_record", return_value=prior_record), \
                patch.object(cancelled_guard, "has_archive", return_value=False):
            with self.assertRaisesRegex(
                module.CancelledActivationRecoveryError,
                "no verified archive",
            ):
                module._require_recovery_current_clear(control, ATTEMPT)
        with patch.object(module, "_read_control_bytes", return_value=b"not-json"):
            with self.assertRaises(module.CancelledActivationRecoveryError):
                module._require_recovery_current_clear(control, ATTEMPT)
        same_attempt = canonical({
            "schema": module.RECOVERY_SCHEMA,
            "activation_attempt": ATTEMPT,
            "state": module.RECOVERY_STATE,
        }) + b"\n"
        with patch.object(module, "_read_control_bytes", return_value=same_attempt):
            with self.assertRaisesRegex(
                module.CancelledActivationRecoveryError,
                "resume its retained journal",
            ):
                module._require_recovery_current_clear(control, ATTEMPT)


class CancelledActivationApplyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.proof = _proof()
        self.control = self.proof["control"]
        self.selected = self.proof["selected"]
        self.identity = self.proof["identity"]
        self.args = _args(self.proof)
        self.records: dict[str, bytes] = {}
        self.stop_calls = 0
        self.terminal_calls: list[dict[str, object]] = []
        self.ready_drain = _drained_receipt(self.proof)
        self.pins = {
            "receipt": self.proof["receipt"],
            "receipt_raw": self.proof["receipt_raw"],
            "result_raw": self.proof["result_raw"],
            "activation_current_raw": self.proof["current_raw"],
            "activation_terminal_raw": None,
        }

    def _patch_common(self, *, build_proofs: list[dict[str, object]] | None = None):
        def read_journal(_control: object, path: str):
            raw = self.records.get(path)
            return (None, None) if raw is None else (module._strict_object(raw, "test journal"), raw)

        def publish(_control: object, path: str, value: object, *, expected_raw: bytes | None):
            old = self.records.get(path)
            if expected_raw is None:
                if old is not None:
                    raise AssertionError("unexpected existing record")
            elif old != expected_raw:
                raise AssertionError("CAS expected bytes differ")
            raw = canonical(dict(value)) + b"\n"
            self.records[path] = raw
            return raw

        def capture(*args: str, **kwargs: object):
            if args and args[0] == "stop":
                self.stop_calls += 1
                return subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")
            if args and args[0] == "inspect":
                state = {
                    "StartedAt": self.proof["backend_started_at"],
                    "FinishedAt": "2026-10-25T10:00:00Z",
                    "Running": False,
                    "OOMKilled": False,
                    "ExitCode": 0,
                }
                rows = [{"Id": BACKEND, "Image": IMAGE, "State": state}]
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps(rows).encode(), stderr=b"")
            raise AssertionError("unexpected Docker command " + repr(args))

        def terminal(args: object, proof: dict[str, object], journal: dict[str, object],
                     _journal_raw: bytes, _pins: object, _control: object):
            self.terminal_calls.append(dict(journal))
            return {"terminal_reached": True, "journal_state": journal["state"]}

        patches = [
            patch.object(module, "_selected_context", return_value=(self.selected, self.identity, self.control)),
            patch.object(module, "_read_journal", side_effect=read_journal),
            patch.object(module, "_publish_cas", side_effect=publish),
            patch.object(module, "docker_capture", side_effect=capture),
            patch.object(module, "_read_terminal_process_receipt", return_value=self.ready_drain),
            patch.object(module, "_verify_frontend_unchanged"),
            patch.object(module, "_resume_pins_from_journal", return_value=self.pins),
            patch.object(module, "_publish_recovery_and_activation_terminal", side_effect=terminal),
        ]
        if build_proofs is not None:
            patches.append(patch.object(module, "_build_proof", side_effect=build_proofs))
        return patches

    def test_fresh_apply_and_drain_confirmed_resume_reach_terminal_without_second_stop(self) -> None:
        patches = self._patch_common(build_proofs=[self.proof, self.proof])
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8]:
            first = module.run(self.args)
            self.assertTrue(first["terminal_reached"])
            self.assertEqual(self.stop_calls, 1)
            journal_path = module._journal_path(ATTEMPT)
            journal = module._strict_object(self.records[journal_path], "journal")
            self.assertEqual(journal["state"], "drain-confirmed")
            self.assertEqual(journal["plan_sha256"], module._plan(self.proof)["plan_sha256"])

            resume_patches = [
                patch.object(module, "_selected_context", return_value=(self.selected, self.identity, self.control)),
                patch.object(module, "_read_journal", side_effect=lambda _c, _p: (
                    module._strict_object(self.records[journal_path], "journal"), self.records[journal_path]
                )),
                patch.object(module, "_proof_from_journal", return_value=self.proof),
                patch.object(module, "_validate_journal_pins"),
                patch.object(module, "_inspect_exact_backend", return_value={
                    "Id": BACKEND, "Image": IMAGE, "State": {
                        "StartedAt": self.proof["backend_started_at"], "Running": False,
                    },
                }),
                patch.object(module, "_verify_saved_drain", return_value=journal["drain"]),
                patch.object(module, "_verify_frontend_unchanged"),
                patch.object(module, "_resume_pins_from_journal", return_value=self.pins),
                patch.object(module, "_publish_recovery_and_activation_terminal", side_effect=lambda *a: {
                    "terminal_reached": True, "journal_state": a[2]["state"],
                }),
            ]
            with resume_patches[0], resume_patches[1], resume_patches[2], resume_patches[3], \
                    resume_patches[4], resume_patches[5], resume_patches[6], resume_patches[7], resume_patches[8]:
                second = module.run(self.args)
            self.assertTrue(second["terminal_reached"])
            self.assertEqual(self.stop_calls, 1)

    def test_prepared_barrier_failure_is_resumable_but_stop_issued_running_is_not_replayed(self) -> None:
        changed = dict(self.proof, current_raw=b"changed marker/current")
        patches = self._patch_common(build_proofs=[self.proof, changed])
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8]:
            with self.assertRaises(ControlOutcomeUnknown):
                module.run(self.args)
            journal_path = module._journal_path(ATTEMPT)
            journal = module._strict_object(self.records[journal_path], "journal")
            self.assertEqual(journal["state"], "prepared")
            self.assertEqual(self.stop_calls, 0)

            running = {"Id": BACKEND, "Image": IMAGE, "State": {
                "StartedAt": self.proof["backend_started_at"], "Running": True,
            }}
            def stop_and_track(*args: str, **kwargs: object):
                if args and args[0] == "stop":
                    self.stop_calls += 1
                return subprocess.CompletedProcess(args, 0)

            resume_patches = [
                patch.object(module, "_selected_context", return_value=(self.selected, self.identity, self.control)),
                patch.object(module, "_read_journal", side_effect=lambda _c, _p: (
                    module._strict_object(self.records[journal_path], "journal"), self.records[journal_path]
                )),
                patch.object(module, "_proof_from_journal", return_value=self.proof),
                patch.object(module, "_validate_journal_pins"),
                patch.object(module, "_inspect_exact_backend", return_value=running),
                patch.object(module, "_build_proof", return_value=self.proof),
                patch.object(module, "docker_capture", side_effect=stop_and_track),
                patch.object(module, "_validate_stopped_incarnation", side_effect=ControlOutcomeUnknown("test stop confirmed")),
            ]
            with resume_patches[0], resume_patches[1], resume_patches[2], resume_patches[3], \
                    resume_patches[4], resume_patches[5], resume_patches[6], resume_patches[7]:
                with self.assertRaises(ControlOutcomeUnknown):
                    module.run(self.args)
            journal = module._strict_object(self.records[journal_path], "journal")
            self.assertEqual(journal["state"], "stop-command-confirmed")
            self.assertEqual(self.stop_calls, 1)

            issued = dict(journal, state="stop-issued", stop_response="pending")
            self.records[journal_path] = canonical(issued) + b"\n"
            with patch.object(module, "_selected_context", return_value=(self.selected, self.identity, self.control)), \
                 patch.object(module, "_read_journal", return_value=(issued, self.records[journal_path])), \
                 patch.object(module, "_proof_from_journal", return_value=self.proof), \
                 patch.object(module, "_validate_journal_pins"), \
                 patch.object(module, "_inspect_exact_backend", return_value=running), \
                 patch.object(module, "docker_capture") as capture:
                with self.assertRaises(ControlOutcomeUnknown):
                    module.run(self.args)
                capture.assert_not_called()

    def test_stale_review_digest_does_not_create_journal_or_stop(self) -> None:
        args = _args(self.proof, digest="0" * 64)
        patches = self._patch_common(build_proofs=[self.proof])
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8]:
            with self.assertRaises(module.CancelledActivationRecoveryError):
                module.run(args)
        self.assertEqual(self.records, {})
        self.assertEqual(self.stop_calls, 0)

    def test_recovery_and_original_terminal_publication_resume_after_release_loss(self) -> None:
        prior_current_raw = canonical({
            "schema": module.RECOVERY_SCHEMA,
            "activation_attempt": PREVIOUS_ATTEMPT,
            "state": module.RECOVERY_STATE,
        }) + b"\n"
        proof = dict(self.proof, previous_recovery_current_raw=prior_current_raw)
        plan = module._plan(proof)
        journal = {
            "schema": module.JOURNAL_SCHEMA,
            "state": "drain-confirmed",
            "journal_path": module._journal_path(ATTEMPT),
            "plan": plan,
            "target": plan["target"],
            "drain": {
                "backend_container": BACKEND,
                "image_id": IMAGE,
                "backend_started_at": proof["backend_started_at"],
                "backend_exit_code": 0,
                "process_receipt_sha256": "9" * 64,
            },
            "docker_stop_command_return_code": 0,
            "stop_response": "confirmed",
        }
        records = {
            "activation/attempts/" + ATTEMPT + "/receipt.json": proof["receipt_raw"],
            "activation/attempts/" + ATTEMPT + "/result.json": proof["result_raw"],
            "activation/current.json": proof["current_raw"],
            module.RECOVERY_CURRENT: prior_current_raw,
        }
        helper_active = [proof["active_raw"], proof["active_raw"], None]
        release_results = [False, True]
        preserved: list[dict[str, object]] = []

        def read(_control: object, path: str, *, optional: bool = False, maximum: int = 0):
            value = records.get(path)
            if value is None and not optional:
                raise AssertionError("missing test control record " + path)
            return value

        def publish(_control: object, path: str, document: object, *, expected_raw: bytes | None):
            old = records.get(path)
            if expected_raw is None:
                if old is not None:
                    if old == canonical(dict(document)) + b"\n":
                        return old
                    raise AssertionError("unexpected immutable record collision")
            elif old != expected_raw:
                raise AssertionError("CAS mismatch")
            raw = canonical(dict(document)) + b"\n"
            records[path] = raw
            return raw

        def validate_active(*_args: object, **_kwargs: object):
            return helper_active.pop(0)

        def preserve(_control: object, _attempt: str, pins: dict[str, object]):
            self.assertEqual(records["activation/attempts/" + ATTEMPT + "/receipt.json"], pins["receipt_raw"])
            self.assertEqual(records["activation/attempts/" + ATTEMPT + "/result.json"], pins["result_raw"])
            self.assertEqual(records["activation/current.json"], pins["activation_current_raw"])
            expected_terminal = pins.get("activation_terminal_raw")
            if expected_terminal is not None:
                self.assertEqual(records["activation/attempts/" + ATTEMPT + "/terminal.json"], expected_terminal)
            preserved.append(dict(pins))

        with patch.object(module, "_read_control_bytes", side_effect=read), \
             patch.object(module, "_publish_cas", side_effect=publish), \
             patch.object(module, "_require_recovery_current_clear", return_value=prior_current_raw), \
             patch.object(module, "_preserve_original_records", side_effect=preserve), \
             patch.object(module, "_verify_frontend_unchanged"), \
             patch.object(module, "_validate_helper_and_active", side_effect=validate_active), \
             patch.object(module, "_wait_retirement_lease_release", side_effect=lambda *a, **k: release_results.pop(0)):
            with self.assertRaises(ControlOutcomeUnknown):
                module._publish_recovery_and_activation_terminal(
                    self.args, proof, journal, b"journal", self.pins, self.control,
                )
            recovery_path = module._recovery_terminal_path(ATTEMPT)
            self.assertEqual(records[recovery_path], records[module.RECOVERY_CURRENT])
            self.assertIn("activation/attempts/" + ATTEMPT + "/terminal.json", records)
            outcome = module._publish_recovery_and_activation_terminal(
                self.args, proof, journal, b"journal", self.pins, self.control,
            )
        self.assertTrue(outcome["active_lease_released"])
        self.assertTrue(outcome["original_records_preserved"])
        terminal = json.loads(records["activation/attempts/" + ATTEMPT + "/terminal.json"])
        self.assertEqual(terminal["activation_state"], module.ACTIVATION_TERMINAL_STATE)
        self.assertEqual(terminal["state"], "failed-confirmed")
        self.assertEqual(terminal["cancelled_recovery_sha256"], hashlib.sha256(records[module.RECOVERY_CURRENT]).hexdigest())
        self.assertGreaterEqual(len(preserved), 3)


if __name__ == "__main__":
    unittest.main()
