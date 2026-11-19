"""Fence cancelled preparation recovery until its exact runtime is archived."""
from __future__ import annotations

import hashlib
import json
import re

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_volume_activate import _read_control_bytes

RECORD = "cancelled-activation-recovery/current.json"
SCHEMA = "fullmag.cancelled-activation-recovery.v1"
SCHEMA_V2 = "fullmag.cancelled-activation-recovery.v2"
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
    return _validate_record(control, raw)


def _validate_record(control, raw, depth=0):
    if depth > 32:
        raise BuildControlError("Cancelled activation recovery history exceeds its bounded depth")
    record = _object(raw, "Cancelled activation recovery record")
    activation = record.get("activation_attempt")
    if (record.get("schema") not in {SCHEMA, SCHEMA_V2}
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
    if record["schema"] == SCHEMA_V2:
        previous = record.get("previous_recovery")
        retired = validate_retired(control, previous, depth=depth + 1)
        if retired["activation_attempt"] == activation:
            raise BuildControlError("Cancelled activation recovery history repeats its activation")
    return record


def replay_index_path(kind, value):
    if kind not in {"request", "state"} or not isinstance(value, str) or not value:
        raise BuildControlError("Cancelled activation replay identity is invalid")
    return "cancelled-activation-recovery/indexes/" + kind + "/" + hashlib.sha256(value.encode("utf-8")).hexdigest() + ".json"


def _retired_pin(record, raw_sha, anchor_raw):
    activation = record["activation_attempt"]
    return {
        "recovery_sha256": raw_sha,
        "activation_attempt": activation,
        "history_path": "cancelled-activation-recovery/history/" + raw_sha + ".json",
        "request_index_path": replay_index_path("request", record.get("request_id")),
        "state_index_path": replay_index_path("state", record.get("state_root")),
        "archive_path": "cancelled-activation-recovery/archives/" + activation + ".json",
        "archive_sha256": hashlib.sha256(anchor_raw).hexdigest(),
    }


def _index_record(pin, record, kind):
    value = record["request_id" if kind == "request" else "state_root"]
    return {"schema": "fullmag.cancelled-activation-replay-index.v1", "kind": kind,
            "key_sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
            "previous_recovery": pin}


def qualified_previous(control, raw_sha, activation_attempt):
    """Qualify an explicit prior current, including its immutable archive anchor."""
    if not isinstance(raw_sha, str) or re.fullmatch(r"[0-9a-f]{64}", raw_sha) is None:
        raise BuildControlError("Previous recovery SHA-256 is invalid")
    raw = _read_control_bytes(control, RECORD)
    if hashlib.sha256(raw).hexdigest() != raw_sha:
        raise BuildControlError("Previous recovery current SHA-256 differs")
    record = read_record(control)
    # Reserve one level for the successor before any Stop is authorized.
    _validate_record(control, raw, depth=1)
    if _read_control_bytes(control, RECORD) != raw:
        raise BuildControlError("Previous recovery current changed during qualification")
    if record is None or record["activation_attempt"] == activation_attempt:
        raise BuildControlError("Previous recovery must belong to a different activation")
    anchor_path = "cancelled-activation-recovery/archives/" + record["activation_attempt"] + ".json"
    anchor_raw = _read_control_bytes(control, anchor_path)
    if _object(anchor_raw, "Previous recovery archive anchor") != control.read(anchor_path):
        raise BuildControlError("Previous recovery archive anchor bytes differ")
    if not has_archive(control, record):
        raise BuildControlError("Previous recovery has no verified immutable archive")
    pin = _retired_pin(record, raw_sha, anchor_raw)
    history = _read_control_bytes(control, pin["history_path"], optional=True)
    if history is not None and history != raw:
        raise BuildControlError("Existing retired recovery history differs")
    for kind in ("request", "state"):
        existing = _read_control_bytes(control, pin[kind + "_index_path"], optional=True)
        if existing is not None and _object(existing, "Existing recovery replay index") != _index_record(pin, record, kind):
            raise BuildControlError("Existing retired recovery replay index differs")
    return pin


def validate_retired(control, pin, *, depth=0):
    if not isinstance(pin, dict) or re.fullmatch(r"[0-9a-f]{64}", str(pin.get("recovery_sha256"))) is None:
        raise BuildControlError("Retired recovery pins are invalid")
    history_path = "cancelled-activation-recovery/history/" + pin["recovery_sha256"] + ".json"
    raw = _read_control_bytes(control, history_path)
    if hashlib.sha256(raw).hexdigest() != pin["recovery_sha256"]:
        raise BuildControlError("Retired recovery history SHA-256 differs")
    record = _validate_record(control, raw, depth)
    anchor_path = "cancelled-activation-recovery/archives/" + record["activation_attempt"] + ".json"
    anchor_raw = _read_control_bytes(control, anchor_path)
    if (_retired_pin(record, pin["recovery_sha256"], anchor_raw) != pin
            or _object(anchor_raw, "Retired recovery archive anchor") != control.read(anchor_path)
            or not has_archive(control, record)):
        raise BuildControlError("Retired recovery archive pins differ")
    for kind in ("request", "state"):
        index_raw = _read_control_bytes(control, pin[kind + "_index_path"])
        if _object(index_raw, "Retired recovery replay index") != _index_record(pin, record, kind):
            raise BuildControlError("Retired recovery replay index differs")
    return record


def preserve_previous(control, pin):
    """Idempotently preserve old raw bytes and direct replay indexes before Stop."""
    from docker_volume_unclaimed_cancellation import _publish_immutable
    qualified = qualified_previous(control, pin["recovery_sha256"], "rotation")
    if qualified != pin:
        raise BuildControlError("Previous recovery pins changed before preservation")
    raw = _read_control_bytes(control, RECORD)
    record = _object(raw, "Previous recovery")
    _publish_immutable(control, pin["history_path"], raw)
    for kind in ("request", "state"):
        _publish_immutable(control, pin[kind + "_index_path"], canonical(_index_record(pin, record, kind)) + b"\n")
    validate_retired(control, pin)


def _assert_not_retired(control, kind, value):
    path = replay_index_path(kind, value)
    raw = _read_control_bytes(control, path, optional=True)
    if raw is None:
        return
    index = _object(raw, "Cancelled activation replay index")
    pin = index.get("previous_recovery")
    record = validate_retired(control, pin)
    if pin[kind + "_index_path"] != path or index != _index_record(pin, record, kind):
        raise BuildControlError("Cancelled activation replay index identity differs")
    raise BuildControlError("Retired cancelled activation " + kind + " cannot be replayed or resumed")


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


def assert_start_allowed(control, request_id=None, *, reuse_state=None, prepared_maintenance=None):
    from docker_volume_linux_supervision_stop import assert_prepared_start_allowed, assert_prepared_maintenance_allowed
    if prepared_maintenance is None:
        assert_prepared_start_allowed(control, request_id, reuse_state=reuse_state)
    else:
        operation, maintenance = prepared_maintenance
        assert_prepared_maintenance_allowed(control, operation, maintenance)
    if request_id is not None:
        _assert_not_retired(control, "request", request_id)
    if reuse_state is not None:
        _assert_not_retired(control, "state", str(reuse_state.get("state")))
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
