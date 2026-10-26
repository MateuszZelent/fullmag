"""Fence cancelled preparation recovery until its exact runtime is archived."""
from __future__ import annotations

import hashlib
import json
import re

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_volume_activate import _read_control_bytes

RECORD = "cancelled-activation-recovery/current.json"
SCHEMA = "fullmag.cancelled-activation-recovery.v1"
TOKEN = re.compile(r"[0-9a-f]{32}\Z")


def _object(raw, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise BuildControlError(label + " contains duplicate JSON keys")
            result[key] = value
        return result

    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, TypeError) as error:
        raise BuildControlError(label + " is not valid JSON") from error
    if not isinstance(value, dict):
        raise BuildControlError(label + " is not an object")
    return value


def _validate_inventory(record):
    tasks = record.get("task_inventory")
    preparations = record.get("preparation_inventory")
    if tasks is None and preparations is None:
        return
    if not isinstance(tasks, list) or not tasks or len(tasks) > 4096:
        raise BuildControlError("Cancelled activation task inventory is invalid")
    task_ids = set()
    for task in tasks:
        if (not isinstance(task, dict)
                or set(task) != {"task_id", "input_fingerprint", "lifecycle", "readiness", "artifact_ids"}
                or not isinstance(task.get("task_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", task["task_id"])
                or task["task_id"].endswith(".")
                or task["task_id"] in task_ids
                or not isinstance(task.get("input_fingerprint"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", task["input_fingerprint"])
                or task.get("lifecycle") != "cancelled"
                or not isinstance(task.get("readiness"), dict)
                or set(task["readiness"]) != {"state", "reason"}
                or task["readiness"].get("state") != "blocked"
                or not isinstance(task["readiness"].get("reason"), str)
                or not task["readiness"]["reason"]
                or task.get("artifact_ids") != []):
            raise BuildControlError("Cancelled activation task inventory contains execution/output state")
        task_ids.add(task["task_id"])
    if not isinstance(preparations, list) or len(preparations) != len(tasks):
        raise BuildControlError("Cancelled activation preparation inventory is incomplete")
    preparation_fields = {
        "task_id", "outcome", "launch_id", "preparation_attempt_id", "resource_id", "lease_token",
        "launch_path", "launch_sha256", "exit_path", "exit_sha256", "lease_path", "lease_sha256",
        "lease_heartbeat_sequence", "exit_code", "timed_out", "lease_state", "released_at",
        "task_receipt_path", "task_receipt_sha256", "stage_receipt_path", "stage_receipt_sha256",
    }
    preparation_ids = set()
    failed = 0
    succeeded = 0
    for preparation in preparations:
        if (not isinstance(preparation, dict)
                or set(preparation) != preparation_fields
                or preparation.get("task_id") not in task_ids):
            raise BuildControlError("Cancelled activation preparation inventory task differs")
        task_id = preparation["task_id"]
        if (task_id in preparation_ids
                or preparation.get("lease_state") != "released"
                or not isinstance(preparation.get("released_at"), str)
                or not preparation["released_at"]):
            raise BuildControlError("Cancelled activation preparation inventory is not unique/released")
        identifiers = ("launch_id", "preparation_attempt_id", "resource_id", "lease_token")
        if any(
            not isinstance(preparation.get(key), str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", preparation[key]) is None
            or preparation[key].endswith(".")
            for key in identifiers
        ):
            raise BuildControlError("Cancelled activation preparation identity is invalid")
        launch_id = preparation["launch_id"]
        resource_id = preparation["resource_id"]
        lease_token = preparation["lease_token"]
        expected_paths = {
            "launch_path": f"preparation_process_launches/{launch_id}.json",
            "exit_path": f"preparation_process_exit_receipts/prep-exit-{launch_id}.json",
            "lease_path": f"preparation_resource_leases/{resource_id}/{lease_token}.json",
        }
        if any(preparation.get(key) != value for key, value in expected_paths.items()):
            raise BuildControlError("Cancelled activation preparation path is not bound to its identity")
        if preparation.get("task_receipt_path") not in {
            None, f"task_preparation_receipts/{task_id}.json",
        } or preparation.get("stage_receipt_path") not in {
            None, f"accepted_stage_preparation_receipts/{task_id}.json",
        }:
            raise BuildControlError("Cancelled activation preparation receipt path is not task-bound")
        for path_key, digest_key in (
            ("launch_path", "launch_sha256"),
            ("exit_path", "exit_sha256"),
            ("lease_path", "lease_sha256"),
            ("task_receipt_path", "task_receipt_sha256"),
            ("stage_receipt_path", "stage_receipt_sha256"),
        ):
            path = preparation.get(path_key)
            digest = preparation.get(digest_key)
            if (path is None) != (digest is None):
                raise BuildControlError("Cancelled activation preparation path/digest pair is incomplete")
            if digest is not None and (
                not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            ):
                raise BuildControlError("Cancelled activation preparation digest is invalid")
        if (type(preparation.get("lease_heartbeat_sequence")) is not int
                or preparation["lease_heartbeat_sequence"] < 0
                or type(preparation.get("exit_code")) is not int
                or preparation["exit_code"] not in {0, 1}
                or preparation.get("timed_out") is not False):
            raise BuildControlError("Cancelled activation preparation terminal state is invalid")
        if preparation.get("outcome") == "failed":
            if (preparation["exit_code"] != 1
                    or preparation.get("task_receipt_path") is not None
                    or preparation.get("stage_receipt_path") is not None):
                raise BuildControlError("Cancelled activation failed preparation contains output")
            failed += 1
        elif preparation.get("outcome") == "succeeded":
            if preparation["exit_code"] != 0 or preparation.get("task_receipt_path") is None:
                raise BuildControlError("Cancelled activation successful preparation is incomplete")
            succeeded += 1
        else:
            raise BuildControlError("Cancelled activation preparation outcome is invalid")
        preparation_ids.add(task_id)
    if preparation_ids != task_ids or failed != 1 or succeeded != 1:
        raise BuildControlError("Cancelled activation preparation inventory does not close the task set")


def read_record(control):
    raw = _read_control_bytes(control, RECORD, optional=True)
    if raw is None:
        return None
    record = _object(raw, "Cancelled activation recovery record")
    activation = record.get("activation_attempt")
    if (record.get("schema") != SCHEMA
            or record.get("state") != "stopped-awaiting-fresh-archive"
            or not isinstance(activation, str) or TOKEN.fullmatch(activation) is None
            or record.get("restart_policy") != "fresh-state-only"
            or record.get("execution_state") != "not-started"):
        raise BuildControlError("Cancelled activation recovery record is invalid")
    continuation_phase = record.get("continuation_phase")
    continuation_attempt = record.get("continuation_attempt")
    if continuation_phase is None:
        continuation_phase = "iteration" if record.get("iteration_attempt") is not None else "development"
        continuation_attempt = record.get("iteration_attempt", record.get("development_attempt"))
    if (continuation_phase not in {"development", "iteration"}
            or not isinstance(continuation_attempt, str)
            or TOKEN.fullmatch(continuation_attempt) is None
            or (continuation_phase == "development" and record.get("iteration_attempt") is not None)
            or (continuation_phase == "iteration" and record.get("iteration_attempt") != continuation_attempt)):
        raise BuildControlError("Cancelled activation continuation pin is invalid")
    _validate_inventory(record)
    immutable = _read_control_bytes(
        control, f"verification/cancelled-activation-{activation}/terminal.json"
    )
    original = _read_control_bytes(control, f"activation/attempts/{activation}/receipt.json")
    terminal = control.read(f"activation/attempts/{activation}/terminal.json")
    if (not isinstance(terminal, dict) or immutable != raw
            or hashlib.sha256(original).hexdigest() != record.get("original_receipt_sha256")
            or terminal.get("cancelled_recovery_sha256") != hashlib.sha256(raw).hexdigest()
            or terminal.get("state") != "failed-confirmed"
            or terminal.get("activation_state") != "operator-cancelled-after-confirmed-drain"):
        raise BuildControlError("Cancelled activation recovery evidence changed")
    return record


def _archive_matches(control, record, generation):
    from docker_volume_preparation_abort import _fresh_archive_matches_abort
    if not _fresh_archive_matches_abort(control, record, generation):
        return False
    root = "recreate-services/attempts/" + generation["generation"]
    archive = control.read(root + "/runtime-control-archive-terminal.json")
    intent_raw = _read_control_bytes(control, root + "/runtime-control-archive-intent.json")
    intent = _object(intent_raw, "Cancelled activation archive intent")
    return (
        hashlib.sha256(intent_raw).hexdigest() == archive.get("intent_sha256")
        and intent.get("source_root") == record.get("source_root")
        and intent.get("previous_state_root") == record.get("state_root")
        and archive.get("removed_containers") == {
            "backend": record.get("backend_container"),
            "frontend": record.get("frontend_container"),
        }
    )


def has_archive(control, record):
    from docker_volume_preparation_abort import _fresh_archive_generation
    anchor = control.read(
        "cancelled-activation-recovery/archives/" + record["activation_attempt"] + ".json",
        optional=True,
    )
    if anchor is not None:
        if (not isinstance(anchor, dict)
                or anchor.get("schema") != "fullmag.cancelled-activation-archive.v1"
                or anchor.get("recovery_sha256") != hashlib.sha256(canonical(record)).hexdigest()):
            raise BuildControlError("Cancelled activation archive anchor differs")
        generation = anchor.get("generation")
    else:
        generation = _fresh_archive_generation(control)
    return generation is not None and _archive_matches(control, record, generation)


def assert_start_allowed(control, request_id=None, *, reuse_state=None):
    record = read_record(control)
    if record is None:
        return
    if request_id is not None and request_id == record.get("request_id"):
        raise BuildControlError("Cancelled activation request cannot be replayed")
    if reuse_state is not None and str(reuse_state.get("state")) == record.get("state_root"):
        raise BuildControlError("Cancelled activation runtime cannot be resumed")
    if not has_archive(control, record):
        raise BuildControlError("Cancelled activation requires verified recreate-volume --fresh-state before start")


def require_fresh_recreation(control, args, previous, *, recreate_services):
    record = read_record(control)
    if record is None:
        return
    if record.get("development_attempt") != previous.get("attempt"):
        if not has_archive(control, record):
            raise BuildControlError("Cancelled activation archive is still pending")
        return
    if (not recreate_services or not getattr(args, "fresh_state", False)
            or record.get("config_sha256") != args.config_sha256
            or record.get("source_root") != previous.get("inputs", {}).get("source_root")
            or record.get("image_id") != previous.get("inputs", {}).get("image_id")
            or record.get("state_root") != previous.get("state_root")):
        raise BuildControlError("Cancelled activation permits only its pinned fresh-state recreation")
    rows = json.loads(docker_capture("inspect", record["backend_container"]).stdout)
    if len(rows) != 1:
        raise BuildControlError("Cancelled backend inspection is ambiguous")
    backend = rows[0]
    state = backend.get("State", {})
    if (backend.get("Id") != record["backend_container"]
            or backend.get("Image") != record["image_id"]
            or state.get("Running") is not False or state.get("OOMKilled") is not False
            or state.get("ExitCode") != 0
            or state.get("StartedAt") != record["backend_started_at"]):
        raise BuildControlError("Cancelled backend was restarted or its drain identity changed")


def pin_archive(control):
    from docker_volume_preparation_abort import _fresh_archive_generation
    from docker_volume_unclaimed_cancellation import _publish_immutable
    record = read_record(control)
    if record is None:
        return
    path = "cancelled-activation-recovery/archives/" + record["activation_attempt"] + ".json"
    if control.read(path, optional=True) is not None:
        if not has_archive(control, record):
            raise BuildControlError("Cancelled activation archive anchor no longer verifies")
        return
    generation = _fresh_archive_generation(control)
    if generation is None or not _archive_matches(control, record, generation):
        raise BuildControlError("Cancelled activation fresh archive is not complete")
    _publish_immutable(control, path, canonical({
        "schema": "fullmag.cancelled-activation-archive.v1",
        "recovery_sha256": hashlib.sha256(canonical(record)).hexdigest(),
        "generation": generation,
    }) + b"\n")
