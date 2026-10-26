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
