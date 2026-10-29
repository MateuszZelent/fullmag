"""Authenticate a managed startup-diagnostic stop for same-store recreation."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Mapping

from docker_build_control import BuildControlError, canonical

SCHEMA = "fullmag.docker-startup-diagnostic-restart.v1"
STOP_SCHEMA = "fullmag.docker-startup-diagnostic-stop.v1"
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[0-9a-f]{32}\Z")


def _require(value, message):
    if not value:
        raise BuildControlError("Startup diagnostic restart: " + message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


class StartupDiagnosticStopContext(dict):
    """Start inputs with an independently authenticated diagnostic-stop witness."""


def validate_metadata(value):
    _require(isinstance(value, Mapping) and set(value) == {
        "schema", "stop_journal_relative", "stop_journal_sha256", "backend_container_id",
        "frontend_container_id", "runtime_config_sha256", "development_attempt",
    } and value.get("schema") == SCHEMA, "metadata schema/fields differ")
    for key in ("stop_journal_sha256", "backend_container_id", "frontend_container_id", "runtime_config_sha256"):
        _require(isinstance(value[key], str) and SHA.fullmatch(value[key]), "invalid " + key)
    _require(value["backend_container_id"] != value["frontend_container_id"], "app containers are not distinct")
    _require(isinstance(value["development_attempt"], str) and TOKEN.fullmatch(value["development_attempt"]),
             "development attempt differs")
    _require(value["stop_journal_relative"] == "verification/stop-startup-diagnostic-" + value["backend_container_id"] + ".json",
             "journal path differs")
    return dict(value)


def _read(control, relative, label):
    from docker_volume_dev import _read_canonical_control_record
    return _read_canonical_control_record(control, relative, label)


def _owner_digest(control):
    # OWNER is in the canonical runtime-control tree, overmounted inside /state.
    raw = control.read_bytes("runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    _require(bool(raw), "retained owner is empty")
    return _sha(raw)


def retained_context(control, previous, document, backend_id, *, fresh_state,
                     authorization, removed_container_proof=None, actual=None):
    """Called only after the caller has authenticated the complete old recovery."""
    import docker_volume_dev as dev
    import docker_volume_container_recovery as recovery
    from docker_volume_pre_ack_retry import _released_snapshot
    from docker_volume_reconcile import fingerprint
    if backend_id is None:
        return None
    _require(isinstance(backend_id, str) and SHA.fullmatch(backend_id), "backend ID is not immutable")
    relative = "verification/stop-startup-diagnostic-" + backend_id + ".json"
    from docker_volume_container_recovery import _control_bytes
    if _control_bytes(control, relative, optional=True) is None:
        return None
    _require(not fresh_state, "requires retained storage")
    raw, journal = _read(control, relative, "startup diagnostic stop journal")
    _require(journal.get("schema") == STOP_SCHEMA and journal.get("state") == "stopped-confirmed",
             "stop has not completed")
    from docker_volume_stop_startup_diagnostic import validate_request, validate_resume
    request = validate_request(journal.get("request", {}))
    _require(journal.get("request_sha256") == _sha(canonical(request) + b"\n"), "request digest differs")
    attempt = previous.get("attempt")
    root = "development/attempts/" + str(attempt)
    prior_raw, prior = _read(control, root + "/terminal.json", "development terminal")
    compose_raw, compose = _read(control, root + "/compose.json", "retained Compose")
    _require(previous.get("phase") == "development"
             and previous.get("compose_project") == control.project
             and previous.get("control_volume") == control.volume,
             "development operation ownership differs")
    _require(prior == previous and compose == document
             and journal.get("development_terminal_sha256") == _sha(prior_raw)
             and journal.get("compose_document_sha256") == _sha(compose_raw), "development/Compose pin differs")
    for key, expected in (("development_attempt", attempt), ("compose_config_sha256", _sha(canonical(document))),
                          ("source_root", previous["inputs"]["source_root"]), ("compose_project", control.project),
                          ("backend_container_id", backend_id), ("backend_image_id", previous["inputs"]["image_id"])):
        _require(request.get(key) == expected, "request pin differs: " + key)
    _require(document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") != "1",
             "cannot activate a startup script")
    _require(_control_bytes(control, "activation/unresolved.json", optional=True) is None,
             "unresolved startup activation remains")
    resume = request.get("resume_attempt")
    _require(isinstance(resume, str) and TOKEN.fullmatch(resume), "missing failed resume attempt")
    resume_raw, resume_record = _read(control, "resume/attempts/" + resume + "/terminal.json", "failed resume terminal")
    validate_resume(resume_record, request, control.project, control.volume)
    _require(_sha(resume_raw) == request.get("resume_terminal_sha256")
             and resume_record.get("state") == "failed-confirmed"
             and resume_record.get("phase") == "resume" and resume_record.get("attempt") == resume
             and resume_record.get("compose_project") == control.project
             and resume_record.get("control_volume") == control.volume
             and resume_record.get("inputs", {}).get("attempt") == attempt
             and resume_record.get("inputs", {}).get("config_sha256") == request["compose_config_sha256"],
             "resume is not the exact failed terminal")
    inspection_raw, inspection = _read(control, request.get("inspection_relative"), "diagnostic inspection")
    _require(_sha(inspection_raw) == request.get("inspection_sha256")
             and inspection == journal.get("inspection")
             and inspection.get("schema") == "fullmag.docker-startup-diagnostic-inspection.v1"
             and inspection.get("state") == "inspected", "inspection differs")
    guest = inspection.get("guest", {})
    _require(inspection.get("backend_container_id") == backend_id
             and inspection.get("image_id") == request["backend_image_id"]
             and inspection.get("backend_started_at") == request.get("backend_started_at")
             and guest.get("active_reservations") == 0 and guest.get("active_local_leases") == 0
             and guest.get("historical_process_receipt_used_as_current") is False,
             "inspection does not prove this diagnostic incarnation")
    for key in ("owner_sha256", "runtime_config_sha256", "historical_process_receipt_sha256"):
        _require(isinstance(guest.get(key), str) and SHA.fullmatch(guest[key])
                 and journal.get(key) == guest[key], "inspection digest differs: " + key)
    _require(request.get("historical_process_receipt_sha256") == guest["historical_process_receipt_sha256"],
             "historical receipt pin differs")
    completed = journal.get("completed_recovery", {})
    auth_raw = recovery._control_bytes(control, document["services"]["backend"]["environment"][recovery.AUTHORIZATION_ENV][len(recovery.CONTROL_ROOT) + 1:])
    receipt_raw = recovery._control_bytes(control, "runtime-control/runtime-services/container-recovery/" + authorization["native_request_sha256"] + "/receipt.json")
    _require(completed == {"authorization_sha256": _sha(auth_raw), "receipt_sha256": _sha(receipt_raw)}
             and dev._validate_completed_recovery_receipt(control, authorization, recovery),
             "completed recovery authentication differs")
    stop = journal.get("stop_operation", {})
    _require(stop.get("phase") == "startup-diagnostic-stop" and isinstance(stop.get("attempt"), str)
             and TOKEN.fullmatch(stop["attempt"])
             and stop.get("root") == "startup-diagnostic-stop/attempts/" + stop["attempt"], "stop operation differs")
    terminal_raw, terminal = _read(control, stop["root"] + "/terminal.json", "stop terminal")
    archived_raw, archived = _read(control, stop["root"] + "/stop-journal.json", "immutable stop journal")
    _require(archived_raw == raw and archived == journal and terminal.get("state") == "succeeded"
             and terminal.get("phase") == stop["phase"] and terminal.get("attempt") == stop["attempt"]
             and terminal.get("compose_project") == control.project
             and terminal.get("control_volume") == control.volume
             and terminal.get("inputs", {}).get("request_sha256") == journal["request_sha256"]
             and terminal.get("startup_diagnostic_stop_sha256") == _sha(raw), "stop terminal does not authenticate journal")
    if actual is None:
        actual = {"backend": json.loads(dev.docker_text("inspect", backend_id))[0],
                  "frontend": json.loads(dev.docker_text("inspect", request["frontend_container_id"]))[0]}
    for service in ("backend", "frontend"):
        observed = actual[service]
        pin = journal.get(service + "_before", {})
        _require(pin == {"container_id": observed.get("Id"), "image_id": observed.get("Image"),
                         "started_at": observed.get("State", {}).get("StartedAt"), "fingerprint": fingerprint(observed)},
                 service + " incarnation differs")
        _require(request.get(service + "_container_id") == observed.get("Id")
                 and request.get(service + "_image_id") == observed.get("Image")
                 and request.get(service + "_started_at") == pin["started_at"], service + " request pin differs")
    after = journal.get("backend_after", {})
    state = actual["backend"].get("State", {})
    _require(all(after.get(key) == journal["backend_before"].get(key) for key in
                 ("container_id", "image_id", "started_at", "fingerprint"))
             and after.get("running") is False and after.get("pid") == 0
             and after.get("oom_killed") is False and type(after.get("exit_code")) is int
             and state.get("Running") is False and state.get("Pid") == 0
             and state.get("OOMKilled") is False and state.get("ExitCode") == after["exit_code"]
             and state.get("FinishedAt") == after.get("finished_at"), "backend stop outcome differs")
    frontend_after = journal.get("frontend_after", {})
    _require(frontend_after == {**journal["frontend_before"], "running": True},
             "frontend stop journal outcome differs")
    if removed_container_proof is not None:
        _require(removed_container_proof.get("container_id") == backend_id
                 and removed_container_proof.get("frontend_container") == request["frontend_container_id"],
                 "removed namespace proof differs")
    else:
        _require(actual["frontend"].get("State", {}).get("Running") is True, "retained frontend changed")
    released = _released_snapshot(control, actual["backend"])
    _require(released.get("active_count") == 0 and released == journal.get("released_before")
             and released == journal.get("released_after"), "released resource inventory changed")
    _require(_owner_digest(control) == journal["owner_sha256"]
             and dev._read_runtime_config_digest(control) == journal["runtime_config_sha256"],
             "retained owner/runtime config changed")
    history_raw = recovery._control_bytes(control, "runtime-control/runtime-service/process-tree.json")
    _require(_sha(history_raw) == journal["historical_process_receipt_sha256"],
             "historical process receipt changed after diagnostic stop")
    metadata = validate_metadata({"schema": SCHEMA, "stop_journal_relative": relative,
        "stop_journal_sha256": _sha(raw), "backend_container_id": backend_id,
        "frontend_container_id": request["frontend_container_id"], "development_attempt": attempt,
        "runtime_config_sha256": journal["runtime_config_sha256"]})
    return StartupDiagnosticStopContext(previous_config_sha256=journal["runtime_config_sha256"],
                                        startup_diagnostic_restart=metadata)
