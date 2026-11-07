"""Authenticate a diagnostic bootstrap stop without inventing a runtime owner.

This is read-only evidence handling. It neither stops services nor edits the
native owner, process receipt, store, or ledger. Container recovery remains
responsible for its normal stopped-pair, storage and destructive-boundary gates.
"""
from __future__ import annotations

from collections.abc import Mapping
import hashlib

from docker_build_control import BuildControlError, canonical
import docker_volume_stop_bootstrap as stop


SCHEMA = "fullmag.docker-bootstrap-stop-recovery-evidence.v1"


def _need(condition, message):
    if not condition:
        raise BuildControlError("Bootstrap recovery evidence: " + message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _paths(attempt, resume, development, fence):
    root = "stop-bootstrap/attempts/" + attempt
    return {
        "stop": root + "/stop-bootstrap-terminal.json",
        "operation": root + "/terminal.json",
        "preflight": root + "/stop-bootstrap-preflight.json",
        "resume": "resume/attempts/" + resume + "/terminal.json",
        "before_process": "resume/attempts/" + resume + "/process-failure.json",
        "development": "development/attempts/" + development + "/terminal.json",
        "compose": "development/attempts/" + development + "/compose.json",
        "fence": stop._runtime_relative(fence),
    }


def collect(control, reference):
    """Freeze an explicitly selected successful stop; never discover a latest one."""
    _need(isinstance(reference, Mapping) and set(reference) == {"attempt", "sha256"},
          "reference must pin the stop attempt and raw terminal digest")
    attempt = reference["attempt"]
    _need(isinstance(attempt, str) and stop.ATTEMPT_RE.fullmatch(attempt), "invalid stop attempt")
    _need(isinstance(reference["sha256"], str) and stop.SHA256_RE.fullmatch(reference["sha256"]),
          "invalid stop terminal digest")
    terminal_raw = stop._read_raw(control, "stop-bootstrap/attempts/" + attempt + "/stop-bootstrap-terminal.json")
    _need(_sha(terminal_raw) == reference["sha256"], "selected stop terminal changed")
    terminal = stop._json(terminal_raw, "bootstrap stop")
    for key in ("attempt", "resume_attempt"):
        _need(isinstance(terminal.get(key), str) and stop.ATTEMPT_RE.fullmatch(terminal[key]),
              "invalid " + key)
    before_raw = stop._read_raw(control, "resume/attempts/" + terminal["resume_attempt"] + "/process-failure.json")
    before = stop._json(before_raw, "bootstrap failed process")
    paths = _paths(attempt, terminal["resume_attempt"], terminal["attempt"], before.get("api_failure_fence"))
    records = {}
    for key, path in paths.items():
        raw = stop._read_raw(control, path)
        records[key] = {"path": path, "raw_utf8": raw.decode("utf-8"), "sha256": _sha(raw)}
    _need(records["stop"]["sha256"] == reference["sha256"], "stop changed during collection")
    return {"schema": SCHEMA, "reference": dict(reference), "records": records}


def validate(evidence, pins, runtime_records, backend, *, control=None):
    """Validate frozen evidence, optionally CAS every source in its control volume.

    runtime_records are the ordinary abrupt proof's four pinned raw documents.
    Their exact paths and authorization hashes are checked here as well so this
    function is safe to call before that enclosing proof has been assembled.
    """
    _need(isinstance(pins, Mapping), "authorization pins are not an object")
    _need(isinstance(backend, Mapping) and isinstance(backend.get("State"), Mapping), "backend observation is incomplete")
    _need(isinstance(evidence, Mapping) and set(evidence) == {"schema", "reference", "records"}
          and evidence["schema"] == SCHEMA, "unsupported frozen schema")
    reference, records = evidence["reference"], evidence["records"]
    _need(isinstance(reference, Mapping) and set(reference) == {"attempt", "sha256"}, "invalid reference")
    attempt = reference["attempt"]
    _need(isinstance(attempt, str) and stop.ATTEMPT_RE.fullmatch(attempt), "invalid stop attempt")
    _need(isinstance(records, Mapping) and set(records) == {
        "stop", "operation", "preflight", "resume", "before_process", "development", "compose", "fence"
    }, "incomplete evidence inventory")
    decoded, raw_records = {}, {}
    for key, record in records.items():
        _need(isinstance(record, Mapping) and set(record) == {"path", "raw_utf8", "sha256"}
              and isinstance(record["raw_utf8"], str), "invalid record " + key)
        raw = record["raw_utf8"].encode("utf-8")
        _need(len(raw) <= stop.MAX_EVIDENCE_BYTES and _sha(raw) == record["sha256"], "changed bytes: " + key)
        decoded[key], raw_records[key] = stop._json(raw, key), raw
    terminal, operation = decoded["stop"], decoded["operation"]
    preflight, before = decoded["preflight"], decoded["before_process"]
    resume, development = decoded["resume"], decoded["development"]
    _need(records["stop"]["sha256"] == reference["sha256"], "stop digest differs from explicit reference")
    for key in ("attempt", "resume_attempt"):
        _need(isinstance(terminal.get(key), str) and stop.ATTEMPT_RE.fullmatch(terminal[key]), "invalid terminal " + key)
    paths = _paths(attempt, terminal["resume_attempt"], terminal["attempt"], before.get("api_failure_fence"))
    for key, path in paths.items():
        _need(records[key]["path"] == path, "unexpected record path: " + key)
        if control is not None:
            _need(stop._read_raw(control, path) == raw_records[key], "stale evidence: " + key)

    runtime = {}
    expected_runtime = {"process_receipt": "runtime-service/process-tree.json",
                        "owner": "runtime-services/OWNER.json", "launch": "runtime-services/LAUNCH.json",
                        "config": "runtime-service/docker-all.json"}
    _need(isinstance(runtime_records, Mapping) and set(runtime_records) == set(expected_runtime), "runtime inventory differs")
    for key, suffix in expected_runtime.items():
        item = runtime_records[key]
        _need(isinstance(item, Mapping) and set(item) == {"path", "raw_utf8", "sha256"}
              and isinstance(item["raw_utf8"], str), "invalid runtime record: " + key)
        raw = item["raw_utf8"].encode("utf-8")
        _need(item["path"] == "runtime-control/" + suffix and len(raw) <= stop.MAX_EVIDENCE_BYTES
              and _sha(raw) == item["sha256"] == pins.get(key + "_sha256"), "runtime pin differs: " + key)
        runtime[key] = stop._json(raw, key)
        if control is not None:
            _need(stop._read_raw(control, item["path"]) == raw, "runtime record changed: " + key)

    _need(terminal.get("schema") == "fullmag.docker-bootstrap-api-stop.v1"
          and terminal.get("state") == "stopped-confirmed"
          and terminal.get("execution_state") == "unknown"
          and terminal.get("backend_running") is False and terminal.get("frontend_running") is True
          and terminal.get("runtime_owner_state") == "ready-history-preserved"
          and terminal.get("resource_leases") == terminal.get("session_store") == "untouched", "stop did not preserve an unknown historical owner")
    bindings = {"attempt": pins.get("development_attempt"), "source_root": pins.get("source_root"),
                "compose_project": pins.get("compose_project"), "config_sha256": pins.get("compose_config_sha256"),
                "backend_container_id": pins.get("backend_container_id"),
                "frontend_container_id": pins.get("frontend_container_id"), "image_id": pins.get("old_image_id")}
    for key, value in bindings.items():
        _need(value is not None and terminal.get(key) == value, "stop identity differs: " + key)
    _need(operation.get("schema") == "fullmag.docker-build-operation.v1"
          and operation.get("attempt") == attempt and operation.get("phase") == "stop-bootstrap"
          and operation.get("state") == "succeeded" and operation.get("execution_state") == "unknown"
          and operation.get("compose_project") == pins["compose_project"]
          and operation.get("stop_state") == "stopped-confirmed"
          and operation.get("stop_bootstrap_terminal_sha256") == _sha(canonical(terminal)), "stop operation is not successfully linked to its canonical terminal")
    if control is not None:
        _need(operation.get("control_volume") == control.volume
              and operation.get("control_namespace") == (control.namespace or None), "stop control identity differs")
    inputs = operation.get("inputs")
    _need(isinstance(inputs, Mapping), "stop operation has no inputs")
    for key, value in bindings.items():
        if key != "compose_project":
            _need(inputs.get(key) == value, "operation input differs: " + key)
    _need(preflight.get("schema") == "fullmag.docker-bootstrap-api-stop-preflight.v1"
          and preflight.get("state") == "preflight-confirmed", "missing qualified preflight")
    shared = ("attempt", "resume_attempt", "config_sha256", "backend_container_id", "frontend_container_id",
              "backend_started_at", "image_id", "development_terminal_sha256", "resume_terminal_sha256",
              "compose_sha256", "failure_fence_sha256", "api_pid", "api_instance_id",
              "current_build_commit", "current_build_snapshot", "resume_process_failure_sha256")
    for key in shared:
        _need(terminal.get(key) is not None and preflight.get(key) == terminal[key], "preflight binding differs: " + key)
        if key != "api_pid":
            _need(inputs.get(key) == terminal[key], "operation input binding differs: " + key)
    for key, field in (("development", "development_terminal_sha256"), ("resume", "resume_terminal_sha256"),
                       ("compose", "compose_sha256"), ("fence", "failure_fence_sha256"),
                       ("before_process", "resume_process_failure_sha256")):
        _need(_sha(raw_records[key]) == terminal.get(field), "linked document differs: " + key)
    _need(_sha(canonical(decoded["compose"])) == pins["compose_config_sha256"], "canonical Compose digest differs")
    _need(isinstance(development.get("inputs"), Mapping) and isinstance(resume.get("inputs"), Mapping),
          "development/resume inputs are not objects")
    _need(development.get("attempt") == pins["development_attempt"]
          and development.get("phase") == "development" and development.get("compose_project") == pins["compose_project"]
          and development.get("inputs", {}).get("source_root") == pins["source_root"], "development identity differs")
    _need(resume.get("phase") == "resume" and resume.get("state") == "failed-confirmed"
          and resume.get("attempt") == terminal["resume_attempt"]
          and resume.get("compose_project") == pins["compose_project"]
          and resume.get("inputs", {}).get("attempt") == pins["development_attempt"]
          and resume.get("inputs", {}).get("config_sha256") == pins["compose_config_sha256"]
          and resume.get("backend_started_at") == terminal["backend_started_at"], "failed resume identity differs")
    _need(isinstance(resume.get("frontend_started_at"), str) and bool(resume["frontend_started_at"]),
          "failed resume does not pin the frontend incarnation")
    _need(backend.get("Id") == pins["backend_container_id"] and backend.get("Image") == pins["old_image_id"]
          and backend.get("State", {}).get("StartedAt") == terminal["backend_started_at"], "backend incarnation differs")

    process, owner, fence = runtime["process_receipt"], runtime["owner"], decoded["fence"]
    _need(process.get("schema") == before.get("schema") == "fullmag.docker-process-tree.v1"
          and before.get("state") == "failed_outcome_retained" and process.get("state") == "shutdown_unknown"
          and process.get("api_diagnostic_only") is True and before.get("api_diagnostic_only") is True
          and not {"service_owner", "runtime_pid", "terminal_service_owner", "startup_activation"}.intersection(process)
          and not {"service_owner", "runtime_pid", "terminal_service_owner", "startup_activation"}.intersection(before)
          and stop._matches_target_build_failure(before.get("error")), "process is not the exact diagnostic stop")
    _need(process.get("shutdown_error") == terminal.get("shutdown_error") == stop.EXPECTED_SHUTDOWN_ERROR
          and type(process.get("api_exit_code")) is int and process["api_exit_code"] == terminal.get("api_exit_code"), "unknown shutdown result differs")
    ignored = {"state", "api_exit_code", "shutdown_error"}
    _need({k: v for k, v in before.items() if k not in ignored} == {k: v for k, v in process.items() if k not in ignored}, "process changed beyond diagnostic shutdown")
    _need(terminal.get("process_receipt_sha256_after") == pins["process_receipt_sha256"]
          and terminal.get("process_receipt_sha256_before") == preflight.get("process_receipt_sha256") == _sha(raw_records["before_process"]), "process byte chain differs")
    _need(terminal.get("owner_sha256_before") == terminal.get("owner_sha256_after") == preflight.get("owner_sha256") == pins["owner_sha256"]
          and terminal.get("runtime_config_sha256") == pins["config_sha256"], "native owner/config changed")
    from docker_volume_stop_failed import _validate_native_ready_owner
    owner = _validate_native_ready_owner(owner)
    launch = runtime["launch"]
    _need(launch.get("schema_version") == "runtime_service_launch.v1"
          and launch.get("state") in ("spawned", "ready")
          and type(launch.get("pid")) is int and launch["pid"] == owner["pid"],
          "LAUNCH is not the exact historical owner")
    _need(owner.get("target_id") == "docker-all"
          and (owner.get("build_commit"), owner.get("build_snapshot")) != (terminal["current_build_commit"], terminal["current_build_snapshot"]), "owner is not the historical build")
    _need(preflight.get("owner_pids_absent") == sorted([owner["pid"], *(child["pid"] for child in owner["children"])]), "absence proof differs from the retained owner")
    _need(fence.get("schema") == "fullmag.api-runtime-failure-fence.v1" and fence.get("stage") == "runtime_startup"
          and fence.get("reason") == before.get("error") and type(before.get("api_pid")) is int
          and before["api_pid"] > 0 and fence.get("api_pid") == before["api_pid"] == terminal["api_pid"]
          and fence.get("api_instance_id") == terminal["api_instance_id"], "startup fence identity differs")
    _need(isinstance(terminal["api_instance_id"], str) and stop.UUID_RE.fullmatch(terminal["api_instance_id"]),
          "API incarnation is not a UUID")
    _need(runtime["config"].get("schema_version") == "runtime_service_config.v2"
          and runtime["config"].get("target_id") == "docker-all"
          and runtime["config"].get("store_root") == "/state/runs/docker-all/session-store", "runtime store binding differs")
    return {"frontend_started_at": resume.get("frontend_started_at"), "stop_attempt": attempt}
