"""Preview or stop one exactly pinned, empty startup-diagnostic namespace."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import uuid

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
import docker_volume_startup_diagnostic as inspection

REQUEST_SCHEMA = "fullmag.docker-startup-diagnostic-stop-request.v1"
JOURNAL_SCHEMA = "fullmag.docker-startup-diagnostic-stop.v1"
FIELDS = {"schema", "request_id", "source_root", "compose_project", "development_attempt",
          "compose_config_sha256", "resume_attempt", "resume_terminal_sha256",
          "backend_container_id", "backend_image_id", "backend_started_at",
          "frontend_container_id", "frontend_image_id", "frontend_started_at",
          "inspection_relative", "inspection_sha256", "historical_process_receipt_sha256", "reason"}


def require(value, message):
    if not value:
        raise BuildControlError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_request(request):
    require(isinstance(request, dict) and set(request) == FIELDS, "Stop request fields differ")
    require(request["schema"] == REQUEST_SCHEMA, "Unsupported startup diagnostic stop request")
    try:
        identifier = uuid.UUID(request["request_id"])
    except (ValueError, TypeError, AttributeError) as error:
        raise BuildControlError("Request ID must be a canonical nonzero UUID") from error
    require(identifier.int != 0 and str(identifier) == request["request_id"], "Request UUID is not canonical")
    for field in ("development_attempt", "resume_attempt"):
        require(re.fullmatch(r"[0-9a-f]{32}", str(request[field])), "Incomplete attempt: " + field)
    for field in ("compose_config_sha256", "resume_terminal_sha256", "backend_container_id",
                  "frontend_container_id", "inspection_sha256", "historical_process_receipt_sha256"):
        require(re.fullmatch(r"[0-9a-f]{64}", str(request[field])), "Incomplete digest/identity: " + field)
    for field in ("backend_image_id", "frontend_image_id"):
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", str(request[field])), "Incomplete image: " + field)
    for field in ("backend_started_at", "frontend_started_at"):
        require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z", str(request[field])),
                "Incomplete Docker start time: " + field)
    validate_control_path(request["inspection_relative"])
    reason = request["reason"]
    require(isinstance(reason, str) and 0 < len(reason.strip()) <= 4096
            and not any(ord(value) < 32 for value in reason), "Invalid stop reason")
    return request


def validate_control_path(value):
    require(isinstance(value, str), "Control path must be text")
    path = PurePosixPath(value)
    require(value.startswith("verification/") and not path.is_absolute() and ".." not in path.parts
            and str(path) == value and value.endswith(".json"), "Invalid control verification path")


def pinned_json(control, relative, expected=None):
    raw = control.read_bytes(relative)
    require(len(raw) <= 4 * 1024 * 1024, "Control evidence exceeds byte bound")
    if expected is not None:
        require(sha(raw) == expected, "Control evidence digest changed: " + relative)
    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "Duplicate control field: " + key)
            value[key] = item
        return value
    try:
        value = json.loads(raw, object_pairs_hook=unique_fields)
    except (ValueError, UnicodeDecodeError) as error:
        raise BuildControlError("Invalid control JSON: " + relative) from error
    require(isinstance(value, dict), "Control evidence must be an object: " + relative)
    return raw, value


def container_pins(actual):
    from docker_volume_reconcile import fingerprint
    return {"container_id": actual["Id"], "image_id": actual["Image"],
            "started_at": actual["State"]["StartedAt"], "fingerprint": fingerprint(actual)}


def validate_resume(resume, request, project, volume):
    require(resume.get("schema") == "fullmag.docker-build-operation.v1"
            and resume.get("phase") == "resume" and resume.get("state") == "failed-confirmed"
            and resume.get("attempt") == request["resume_attempt"]
            and resume.get("compose_project") == project and resume.get("control_volume") == volume,
            "Startup stop requires the exact terminal failed-confirmed resume")
    inputs = resume.get("inputs", {})
    require(inputs.get("attempt") == request["development_attempt"]
            and inputs.get("config_sha256") == request["compose_config_sha256"]
            and resume.get("config_sha256") == request["compose_config_sha256"]
            and resume.get("backend_started_at") == request["backend_started_at"],
            "Resume does not pin this development/configuration/incarnation")
    group = resume.get("worker_cgroup", {})
    require(group.get("schema") == "fullmag.worker-cgroup-ready.v1"
            and group.get("state") == "ready" and group.get("container_id") == request["backend_container_id"]
            and group.get("image_id") == request["backend_image_id"]
            and group.get("compose_project") == project,
            "Resume lacks exact cgroup admission for this backend")


def verify(control, request, selected):
    import docker_volume_dev as dev
    import docker_volume_container_recovery as recovery
    from docker_dev_recovery_build import inspect_one, validate_backend
    from docker_compose_identity import validate_source_labels
    from docker_volume_pre_ack_retry import _released_snapshot
    previous_raw, previous = pinned_json(control, "development/attempts/" + request["development_attempt"] + "/terminal.json")
    require(previous.get("schema") == "fullmag.docker-build-operation.v1"
            and previous.get("phase") == "development" and previous.get("state") in {"succeeded", "failed-confirmed"}
            and previous.get("attempt") == request["development_attempt"]
            and previous.get("compose_project") == control.project
            and previous.get("control_volume") == control.volume
            and previous.get("inputs", {}).get("source_root") == str(selected), "Development authority differs")
    document_raw, document = pinned_json(control, "development/attempts/" + request["development_attempt"] + "/compose.json")
    require(sha(canonical(document)) == request["compose_config_sha256"]
            and document.get("name") == control.project, "Compose authority differs")
    resume_raw, resume = pinned_json(control, "resume/attempts/" + request["resume_attempt"] + "/terminal.json",
                                     request["resume_terminal_sha256"])
    validate_resume(resume, request, control.project, control.volume)
    inspection_raw, report = pinned_json(control, request["inspection_relative"], request["inspection_sha256"])
    require(report.get("schema") == inspection.SCHEMA and report.get("state") == "inspected"
            and report.get("source_root") == str(selected) and report.get("compose_project") == control.project
            and report.get("backend_container_id") == request["backend_container_id"]
            and report.get("image_id") == request["backend_image_id"]
            and report.get("backend_started_at") == request["backend_started_at"]
            and report.get("probe_sha256") == sha(inspection.PROBE.encode()), "Inspection is not the pinned current API proof")
    backend = inspect_one("container", request["backend_container_id"])
    validate_backend(backend, control.identity, request["backend_container_id"], request["backend_image_id"])
    frontend = inspect_one("container", request["frontend_container_id"])
    validate_source_labels(frontend, control.identity)
    require(frontend.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") == control.project
            and frontend.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") == "frontend"
            and frontend["State"].get("Running") is True, "Frontend ownership/state differs")
    for service, actual in (("backend", backend), ("frontend", frontend)):
        require(actual["Image"] == request[service + "_image_id"]
                and actual["Image"] == document["services"][service]["image"]
                and actual["State"]["StartedAt"] == request[service + "_started_at"]
                and actual["State"].get("OOMKilled") is not True, "Service incarnation/image differs: " + service)
    require(container_pins(backend)["fingerprint"] == report["container_fingerprint"], "Backend properties changed")
    result = docker_capture("exec", backend["Id"], "python3", "-B", "-c", inspection.PROBE, timeout=60)
    require(result.returncode == 0, "Startup diagnostic probe did not succeed")
    guest = json.loads(result.stdout)
    require(guest == report.get("guest"), "Startup API, owner, fence or resource evidence changed")
    require(guest["historical_process_receipt_sha256"] == request["historical_process_receipt_sha256"],
            "Historical process receipt changed")
    released = _released_snapshot(control, backend)
    # Reuse all existing authorization/source/metadata gates before binding the completed receipt.
    carried = dev._retained_recovery_context(control, previous, document, fresh_state=False, backend_id=backend["Id"])
    environment = carried.get("recovery_environment")
    require(isinstance(environment, dict) and set(environment) == {recovery.AUTHORIZATION_ENV, recovery.AUTHORIZATION_SHA_ENV},
            "Stop requires the original complete recovery capability")
    relative = recovery._relative_control_path(environment[recovery.AUTHORIZATION_ENV][len(recovery.CONTROL_ROOT) + 1:])
    authorization_raw, authorization = pinned_json(control, relative, environment[recovery.AUTHORIZATION_SHA_ENV])
    authorization = recovery.validate_runtime_authorization(authorization)
    require(dev._validate_completed_recovery_receipt(control, authorization, recovery), "Recovery is not fully completed")
    receipt_raw, _ = pinned_json(control, "runtime-control/runtime-services/container-recovery/" + authorization["native_request_sha256"] + "/receipt.json")
    return {"inspection": report, "development_terminal_sha256": sha(previous_raw),
            "compose_document_sha256": sha(document_raw), "backend_before": container_pins(backend),
            "frontend_before": container_pins(frontend), "released_before": released,
            "completed_recovery": {"authorization_sha256": sha(authorization_raw), "receipt_sha256": sha(receipt_raw)},
            "historical_process_receipt_sha256": guest["historical_process_receipt_sha256"],
            "owner_sha256": guest["owner_sha256"], "runtime_config_sha256": guest["runtime_config_sha256"]}, backend, frontend


def unchanged_control_evidence(control, evidence):
    for field, relative in (("owner_sha256", "runtime-control/runtime-services/OWNER.json"),
                            ("runtime_config_sha256", "runtime-control/runtime-service/docker-all.json"),
                            ("historical_process_receipt_sha256", "runtime-control/runtime-service/process-tree.json")):
        require(sha(control.read_bytes(relative)) == evidence[field], "Preserved runtime evidence changed: " + field)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "image-id", "request", "request-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", args.image_id), "Full image pin required")
    require(re.fullmatch(r"[0-9a-f]{64}", args.request_sha256), "Full request digest required")
    validate_control_path(args.request)
    from docker_dev import _select_source, _compose_identity
    from docker_dev_recovery_build import inspect_one
    from docker_volume_pre_ack_retry import _released_snapshot
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    request_raw, request = pinned_json(control, args.request, args.request_sha256)
    validate_request(request)
    require(request_raw == canonical(request) + b"\n", "Stop request must use canonical control JSON")
    require(request["source_root"] == str(selected) and request["compose_project"] == control.project
            and request["backend_image_id"] == args.image_id, "Request source/project/image differs")
    inputs = {"request_sha256": args.request_sha256, "source_root": str(selected),
              "controller_sha256": sha(Path(__file__).read_bytes()), "probe_sha256": sha(inspection.PROBE.encode())}
    # Refuse an active/unknown resume before trying to acquire its control lease.
    _, resume = pinned_json(control, "resume/attempts/" + request["resume_attempt"] + "/terminal.json", request["resume_terminal_sha256"])
    validate_resume(resume, request, control.project, control.volume)
    if args.apply:
        preview = control.read("startup-diagnostic-stop-preview/verified.json")
        require(isinstance(preview, dict) and preview.get("phase") == "startup-diagnostic-stop-preview" and preview.get("state") == "succeeded"
                and preview.get("inputs") == inputs, "Apply requires a successful preview of these exact inputs")
        _, terminal = pinned_json(control, "startup-diagnostic-stop-preview/attempts/" + preview["attempt"] + "/terminal.json")
        require(terminal == preview, "Preview pointer differs from its immutable terminal")
    phase = "startup-diagnostic-stop" if args.apply else "startup-diagnostic-stop-preview"
    with control.operation(phase, inputs) as operation:
        evidence, backend, frontend = verify(control, request, selected)
        expected = {backend["Id"], frontend["Id"], operation["helper_container_id"]}
        require(_project_container_ids(control.project) == expected and _volume_consumer_ids(control.volume) == expected,
                "Another group/control consumer is present")
        unchanged_control_evidence(control, evidence)
        control.write(operation["root"] + "/preflight.json", evidence)
        if not args.apply:
            operation["receipt"].update(state="succeeded", result={"state": "preview-passed", "stop_applied": False})
            print(json.dumps({"state": "preview-passed", "stop_applied": False, "operation": operation["root"]}))
            return
        require(preview.get("result", {}).get("state") == "preview-passed", "Preview did not pass")
        # Recheck immutable process and namespace pins immediately before the only signal.
        fresh, _, _ = verify(control, request, selected)
        require(fresh == evidence, "Stop evidence changed under the operation lease")
        journal = {"schema": JOURNAL_SCHEMA, "state": "stop-planned", "request": request,
                   "request_sha256": args.request_sha256, "inspection_sha256": request["inspection_sha256"], **evidence,
                   "stop_operation": {"phase": phase, "attempt": operation["receipt"]["attempt"], "root": operation["root"]}}
        relative = "verification/stop-startup-diagnostic-" + backend["Id"] + ".json"
        require(control.read(relative, optional=True) is None, "A stop intent already exists; do not repeat the signal")
        control.write(relative, journal)
        operation["daemon_pending"] = True
        docker_capture("stop", "--time", "60", backend["Id"], timeout=90)
        stopped = inspect_one("container", backend["Id"])
        current_frontend = inspect_one("container", frontend["Id"])
        require(container_pins(stopped) == evidence["backend_before"]
                and stopped["State"].get("Running") is False and stopped["State"].get("Pid") == 0
                and stopped["State"].get("OOMKilled") is not True
                and type(stopped["State"].get("ExitCode")) is int, "Backend stop is not confirmed")
        require(container_pins(current_frontend) == evidence["frontend_before"]
                and current_frontend["State"].get("Running") is True, "Frontend incarnation changed")
        unchanged_control_evidence(control, evidence)
        released_after = _released_snapshot(control, stopped)
        require(released_after == evidence["released_before"], "Released store/ledger inventory changed")
        journal.update(state="stopped-confirmed", released_after=released_after,
            backend_after={**container_pins(stopped), "finished_at": stopped["State"]["FinishedAt"],
                           "exit_code": stopped["State"]["ExitCode"], "running": False, "pid": 0, "oom_killed": False},
            frontend_after={**container_pins(current_frontend), "running": True})
        control.write(operation["root"] + "/stop-journal.json", journal)
        control.write(relative, journal)
        operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", startup_diagnostic_stop_sha256=sha(canonical(journal) + b"\n"),
                                    result={"state": "stopped-confirmed", "journal": relative,
                                                             "journal_sha256": sha(canonical(journal) + b"\n")})
        print(json.dumps(operation["receipt"]["result"]))


if __name__ == "__main__":
    main()
