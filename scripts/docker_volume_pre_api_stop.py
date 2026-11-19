"""Preserve an owned pre-API stop or exact startup failure without run replay."""
from __future__ import annotations

import hashlib
import base64
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import time

from docker_build_control import (
    MAX_DOCUMENT_BYTES,
    BuildControl,
    BuildControlError,
    canonical,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_host import require_host
from docker_volume_resources import _fence, _inspect, _pause_start, _resource_lock, _RESUME_START

SCHEMA = "fullmag.docker-pre-api-stop.v1"
SUFFIX = "/pre-api-stop/"
ACTION_CAPTURE_FAILURE = "observe-capture-failure"
ACTION_NATIVE_INIT_FAILURE = "observe-native-host-init-failure"
MAX_PRE_API_FAILURE_RECORD_BYTES = MAX_DOCUMENT_BYTES


class PreApiContext(dict):
    """In-memory witness: this context passed the pre-API stop validator."""


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _checkpoint(control, previous):
    import fullmag_storage as storage
    from docker_volume_accepted_reattach import _bundle_from_records, _control_bytes
    from docker_volume_pre_ack_retry import _service
    document = control.read("development/attempts/" + previous["attempt"] + "/compose.json")
    mounts = [item for item in document["services"]["backend"]["volumes"]
              if item.get("target") == "/state" and item.get("type") == "bind"]
    if len(mounts) != 1:
        raise BuildControlError("Pre-API checkpoint requires one exact retained state bind")
    layout = storage.resolve_layout(Path(previous["inputs"]["source_root"]), "docker-all-gpu")
    state = storage.validate_path(Path(mounts[0]["source"]), Path(layout["runtime_root"]), "pre-API retained state")
    if previous.get("state_root") is not None and Path(previous["state_root"]) != state:
        raise BuildControlError("Pre-API retained state differs from its Compose bind")
    bundle = _bundle_from_records(control, store_root=state / "runs/docker-all/session-store")
    request, proof = bundle["request"], bundle["proof"]
    relative = str(PurePosixPath(request["proof_path"]).parent / "pre-ack-retry.json")
    raw = _control_bytes(control, "runtime-control/" + relative)
    retry = json.loads(raw)

    def read_record(path, label):
        data = _control_bytes(control, path)
        return data, json.loads(data)

    _service()._validate_pre_ack_retry_record(
        retry, raw, request, proof, bundle["request_sha256"], read_record
    )
    records = {
        name: _sha(_control_bytes(control, name)) for name in (
            "runtime-control/runtime-service/process-tree.json",
            "runtime-control/runtime-services/OWNER.json",
            "runtime-control/runtime-service/docker-all.json",
        )
    }
    metadata = previous.get("inputs", {}).get("native_failed_restart")
    if (not isinstance(metadata, dict) or _sha(canonical(metadata)) != retry["native_restart_sha256"]
            or records["runtime-control/runtime-service/process-tree.json"] != retry["current_process_sha256"]
            or records["runtime-control/runtime-services/OWNER.json"] != retry["owner_sha256"]
            or records["runtime-control/runtime-service/docker-all.json"] != metadata["previous_config_sha256"]):
        raise BuildControlError("Pre-API stop requires the unchanged original pre-ACK owner/process/config")
    return {"records": records, "request_sha256": bundle["request_sha256"],
            "proof_sha256": bundle["proof_sha256"], "pre_ack_sha256": _sha(raw),
            "pre_ack_path": relative, "native_restart_metadata": metadata}


_RETENTION_PROBE = """import hashlib,json,os,pathlib,re,stat,sys
def read(path,maximum):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_size>maximum: raise RuntimeError('unbounded publication input')
  raw=os.read(fd,maximum+1); after=os.fstat(fd)
  if len(raw)!=before.st_size or (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise RuntimeError('publication input changed')
  return raw
 finally: os.close(fd)
p=pathlib.Path('/proc')/sys.argv[1]
if (p/'task'/sys.argv[1]/'children').read_text().strip(): raise RuntimeError('startup still has child processes')
files=[]
for fd in (p/'fd').iterdir():
 try:
  path=os.readlink(fd)
  if not re.fullmatch(r'/opt/fullmag/package/\\.development/backups/\\.backend-package-backup-[A-Za-z0-9._-]+/(bin|lib)/[^/]+',path): continue
  flags=int(next(x.split()[1] for x in (p/'fdinfo'/fd.name).read_text().splitlines() if x.startswith('flags:')),8)
  if flags&os.O_ACCMODE!=os.O_RDONLY: raise RuntimeError('backup descriptor is writable')
  if not stat.S_ISREG(fd.stat().st_mode): raise RuntimeError('backup descriptor is not regular')
  files.append(path)
 except FileNotFoundError: continue
if len(files)!=1: raise RuntimeError('startup is not reading one historical rollback artifact')
r=read('/opt/fullmag/package/backend-build-receipt.json',8388608)
v=read('/opt/fullmag/control/backend/runtime-provenance.json',1048576)
receipt=json.loads(r); provenance=json.loads(v)
if (receipt.get('state')!='succeeded' or provenance.get('state')!='succeeded' or provenance.get('image_id')!=sys.argv[2]
    or provenance.get('build_receipt_sha256')!=hashlib.sha256(r).hexdigest()): raise RuntimeError('current package publication is not confirmed')
print(json.dumps({'backup_artifact':files[0],'build_receipt_sha256':hashlib.sha256(r).hexdigest(),
 'provenance_sha256':hashlib.sha256(v).hexdigest(),
 'startup_helper_sha256':hashlib.sha256(read('/opt/fullmag/backend_dev.py',1048576)).hexdigest()}))
"""

_TERMINATE = """import os,pathlib,signal,sys
pid=int(sys.argv[1]); p=pathlib.Path('/proc')/str(pid); fd=os.pidfd_open(pid)
try:
 value=(p/'stat').read_text(); token=value[value.rfind(')')+2:].split()[19]
 args=(p/'cmdline').read_bytes().decode().split('\\0')
 if token!=sys.argv[2] or args[1:3]!=['/opt/fullmag/backend_dev.py','start']: raise RuntimeError('startup identity changed')
 if next(x.split()[1] for x in (p/'status').read_text().splitlines() if x.startswith('State:'))!='T': raise RuntimeError('startup is not paused')
 signal.pidfd_send_signal(fd,signal.SIGTERM,None,0)
 signal.pidfd_send_signal(fd,signal.SIGCONT,None,0)
finally: os.close(fd)
"""


def stop(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_pre_ack_retry import _publish_raw, _released_snapshot
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    if (identity["project_name"] != "fullmag-master"
            or not re.fullmatch(r"[0-9a-f]{32}", args.attempt)
            or not re.fullmatch(r"[0-9a-f]{64}", args.backend_container_id)):
        raise BuildControlError("Pre-API stop requires exact fullmag-master development identities")
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    root = "development/attempts/" + args.attempt
    previous, document = control.read(root + "/receipt.json"), control.read(root + "/compose.json")
    if args.finalize:
        return _finalize(control, root, args)
    if args.resume_unissued:
        return _resume_unissued(control, root, args, selected, identity, previous, document)
    if previous.get("state") != "starting":
        raise BuildControlError("Pre-API stop requires the still-active development start")
    with _resource_lock(control, root, args.attempt):
        if control.read(root + SUFFIX + "intent.json", optional=True) is not None:
            raise BuildControlError("A pre-API stop was already issued; observe it instead of repeating")
        actual, probe = _fence(control, args.attempt, root, selected, identity,
                               args.backend_container_id, document, previous)
        checkpoint = _checkpoint(control, previous)
        released = _released_snapshot(control, actual)
        artifact = json.loads(docker_capture("exec", actual["Id"], "/usr/local/bin/python3",
                              "-I", "-B", "-c", _RETENTION_PROBE, str(probe["pid"]), actual["Image"]).stdout)
        record = {"schema": SCHEMA, "state": "planned", "action": "cancel-retention", "attempt": args.attempt,
                  "compose_project": control.project, "control_namespace": control.namespace,
                  "source_root": str(selected), "config_sha256": _sha(canonical(document)),
                  "container_id": actual["Id"], "image_id": actual["Image"],
                  "started_at": actual["State"]["StartedAt"],
                  "process": {key: probe[key] for key in ("pid", "start_token")},
                  "checkpoint": checkpoint, "released": released, "publication": artifact}
        if not args.apply:
            print(json.dumps({key: record[key] for key in (
                "schema", "state", "attempt", "compose_project", "container_id", "image_id",
                "started_at", "config_sha256", "process", "publication"
            )} | {"checkpoint_sha256": _sha(canonical(checkpoint)),
                  "released_active_count": released["active_count"],
                  "released_snapshot_sha256": _sha(canonical(released)),
                  "same_held_run": True}, indent=2))
            return
        # Fence again, then freeze before deciding that no API/gate can race us.
        pinned, live = _fence(control, args.attempt, root, selected, identity,
                              args.backend_container_id, document, previous)
        if pinned["State"]["StartedAt"] != record["started_at"] or any(
                live[key] != probe[key] for key in ("pid", "start_token")):
            raise BuildControlError("Pre-API stop backend incarnation changed")
        with _pause_start(actual["Id"], probe, pause_seconds=600) as pause:
            observed_artifact = json.loads(docker_capture("exec", actual["Id"], "/usr/local/bin/python3",
                                         "-I", "-B", "-c", _RETENTION_PROBE, str(probe["pid"]), actual["Image"]).stdout)
            if any(observed_artifact[key] != artifact[key] for key in artifact if key != "backup_artifact"):
                raise BuildControlError("Historical rollback reader/publication changed before pause")
            record["publication"] = observed_artifact
            if _checkpoint(control, previous) != checkpoint or _released_snapshot(control, actual) != released:
                raise BuildControlError("Pre-API authority/resources changed before cancellation")
            pause["process"].stdin.write(b"ARM\n")
            pause["process"].stdin.flush()
            if BuildControl._line(pause["process"], timeout=5) != "ARMED":
                raise BuildControlError("Pre-API stop pause was not armed")
            # Unknown publication must keep startup held, even before signalling.
            pause["issued"] = True
            try:
                _publish_raw(control, root + SUFFIX + "intent.json", canonical(record) + b"\n",
                             helper_name="fullmag-pre-api-intent-" + args.attempt)
            except (BuildControlError, OSError, subprocess.SubprocessError):
                from docker_volume_accepted_reattach import _control_bytes
                if _control_bytes(control, root + SUFFIX + "intent.json", optional=True) != canonical(record) + b"\n":
                    raise BuildControlError("Pre-API intent publication is unknown; startup remains held")
            # Signal once. A client failure is not proof that the daemon did nothing.
            try:
                docker_capture("exec", actual["Id"], "/usr/local/bin/python3", "-I", "-B", "-c",
                               _TERMINATE, str(probe["pid"]), probe["start_token"], timeout=10)
            except (BuildControlError, OSError, subprocess.SubprocessError):
                pass
            deadline = time.monotonic() + 20
            while True:
                stopped = _inspect("inspect", actual["Id"], timeout=10)
                if stopped["State"]["Running"] is False or time.monotonic() >= deadline:
                    break
                time.sleep(.2)
        state = stopped["State"]
        if (stopped["Id"] != actual["Id"] or stopped["Image"] != actual["Image"]
                or state["StartedAt"] != record["started_at"] or state["Running"] is not False
                or state["Status"] != "exited" or state["Pid"] != 0 or state["OOMKilled"] is not False
                or state["ExitCode"] != 143):
            raise BuildControlError("Pre-API stop outcome is unknown; intent retained, no new start allowed")
        if _checkpoint(control, previous) != checkpoint or _released_snapshot(control, stopped) != released:
            raise BuildControlError("Pre-API stop changed retained authority/store; no new start allowed")
        intent_sha = _sha(canonical(record) + b"\n")
        record.update(state="stopped-confirmed", finished_at=state["FinishedAt"], exit_code=state["ExitCode"],
                      intent_sha256=intent_sha)
        _publish_raw(control, root + SUFFIX + "receipt.json", canonical(record) + b"\n")
        print(json.dumps({"state": record["state"], "attempt": args.attempt,
                          "container_id": actual["Id"], "receipt": root + SUFFIX + "receipt.json",
                          "receipt_sha256": _sha(canonical(record) + b"\n")}, indent=2))


def _resume_unissued(control, root, args, selected, identity, previous, document):
    """Recover a hold before intent publication; never resume an issued stop."""
    from docker_volume_accepted_reattach import _control_bytes
    from docker_volume_pre_ack_retry import _publish_raw, _released_snapshot
    publisher = "fullmag-pre-api-intent-" + args.attempt

    def no_publisher_or_intent():
        result = docker_capture("inspect", publisher, allow_failure=True, timeout=30)
        detail = (result.stderr + result.stdout).decode("utf-8", "replace")
        if result.returncode == 0 or re.search(
                r"(?:no such object|no such container):\s*" + re.escape(publisher) + r"(?:\s|$)",
                detail, re.IGNORECASE) is None:
            raise BuildControlError("Pre-API intent publisher is present or its outcome is unknown")
        present = docker_capture("ps", "--all", "--quiet", "--no-trunc", "--filter", "name=^/" + publisher + "$")
        if (present.stdout.strip()
                or _control_bytes(control, root + SUFFIX + "intent.json", optional=True) is not None
                or _control_bytes(control, root + SUFFIX + "receipt.json", optional=True) is not None):
            raise BuildControlError("A pre-API intent exists or may still be published; resume refused")

    with _resource_lock(control, root, args.attempt):
        no_publisher_or_intent()
        actual, probe = _fence(control, args.attempt, root, selected, identity,
                               args.backend_container_id, document, previous)
        _checkpoint(control, previous)
        _released_snapshot(control, actual)
        no_publisher_or_intent()
        result = docker_capture("exec", actual["Id"], "/usr/local/bin/python3", "-I", "-B", "-c",
                                _RESUME_START, str(probe["pid"]), probe["start_token"], timeout=10)
        print(json.dumps({"state": "unissued-hold-resumed", "attempt": args.attempt,
                          "container_id": actual["Id"], "resume": json.loads(result.stdout)}, indent=2))


def _finalize(control, root, args):
    """Observe an existing stopped intent; never send another signal."""
    from docker_volume_pre_ack_retry import _publish_raw, _released_snapshot
    from docker_volume_accepted_reattach import _control_bytes
    relative = root + SUFFIX
    raw = _control_bytes(control, relative + "intent.json", maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
    intent = json.loads(raw)
    if (intent.get("schema") != SCHEMA or intent.get("state") != "planned"
            or intent.get("attempt") != args.attempt or intent.get("compose_project") != control.project
            or intent.get("control_namespace") != control.namespace
            or intent.get("source_root") != str(Path(args.source_root).resolve(strict=True))
            or intent.get("container_id") != args.backend_container_id):
        raise BuildControlError("Pre-API finalization intent identity differs")
    with control.operation("pre-api-finalization", {"attempt": args.attempt, "intent_sha256": _sha(raw)}) as operation:
        previous = control.read(root + "/terminal.json")
        if (previous.get("state") != "failed-confirmed" or previous.get("attempt") != args.attempt
                or _control_bytes(control, relative + "intent.json", maximum=MAX_PRE_API_FAILURE_RECORD_BYTES) != raw):
            raise BuildControlError("Pre-API finalization requires the same terminal development attempt")
        if intent.get("action") == ACTION_NATIVE_INIT_FAILURE:
            previous_raw = _control_bytes(control, root + "/terminal.json",
                                          maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
            previous = json.loads(previous_raw)
            inputs = previous.get("inputs")
            current_raw = _control_bytes(control, "development/current.json",
                                         maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
            compose_raw = _control_bytes(control, root + "/compose.json",
                                         maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
            compose = json.loads(compose_raw)
            config_sha256 = _sha(canonical(compose))
            if (current_raw != previous_raw
                    or _sha(previous_raw) != intent.get("development_terminal_sha256")
                    or previous.get("schema") != "fullmag.docker-build-operation.v1"
                    or previous.get("phase") != "development"
                    or previous.get("state") != "failed-confirmed"
                    or previous.get("attempt") != args.attempt
                    or previous.get("compose_project") != control.project
                    or not isinstance(inputs, dict)
                    or inputs.get("source_root") != intent["source_root"]
                    or inputs.get("image_id") != intent["image_id"]
                    or (previous.get("backend_container") is not None
                        and previous.get("backend_container") != intent["container_id"])
                    or (previous.get("config_sha256") is not None
                        and previous.get("config_sha256") != config_sha256)
                    or config_sha256 != intent.get("config_sha256")
                    or compose.get("name") != control.project
                    or (control.namespace
                        and compose.get("x-fullmag-control-namespace") != control.namespace)
                    or (not control.namespace and "x-fullmag-control-namespace" in compose)):
                raise BuildControlError("Native-init finalization requires its exact current failed attempt and Compose")
        actual = _inspect("inspect", args.backend_container_id)
        if intent.get("action") == ACTION_NATIVE_INIT_FAILURE:
            from docker_volume_dev import _validate_retained_service
            image_document = _inspect("image", "inspect", actual.get("Image"))
            if (image_document.get("Id") != intent.get("image_id")
                    or not isinstance(image_document.get("Config"), dict)):
                raise BuildControlError("Native-init finalization image is not the exact immutable image")
            _validate_retained_service(compose, actual, "backend", image_document["Config"])
        state = actual["State"]
        expected_exit = _expected_exit(intent)
        if (actual["Id"] != intent["container_id"] or actual["Image"] != intent["image_id"]
                or state["StartedAt"] != intent["started_at"] or state["Running"] is not False
                or state["Status"] != "exited" or state["Pid"] != 0 or state["OOMKilled"] is not False
                or state["ExitCode"] != expected_exit):
            raise BuildControlError("Pre-API finalization found no exact confirmed termination")
        _validate_capture_evidence(intent, actual)
        if (_checkpoint(control, previous) != intent["checkpoint"]
                or _released_snapshot(control, actual) != intent["released"]):
            raise BuildControlError("Pre-API finalization authority/resources differ")
        record = dict(intent, state="stopped-confirmed", finished_at=state["FinishedAt"],
                      exit_code=expected_exit, intent_sha256=_sha(raw))
        existing = _control_bytes(control, relative + "receipt.json", optional=True,
                                  maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
        if existing is None:
            _publish_raw(control, relative + "receipt.json", canonical(record) + b"\n",
                         maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
        elif existing != canonical(record) + b"\n":
            raise BuildControlError("Pre-API finalization receipt differs from this intent")
        operation["receipt"].update(state="succeeded", parent_attempt=args.attempt,
                                     receipt_sha256=_sha(canonical(record) + b"\n"))
        print(json.dumps({"state": "stopped-confirmed", "signal_repeated": False,
                          "receipt": relative + "receipt.json"}, indent=2))


def _expected_exit(record):
    if record.get("action") == "cancel-retention":
        return 143
    if record.get("action") == ACTION_CAPTURE_FAILURE:
        return 2
    if record.get("action") == ACTION_NATIVE_INIT_FAILURE:
        return 1
    raise BuildControlError("Unknown pre-API checkpoint action")


def _validate_capture_evidence(record, actual=None):
    action = record.get("action")
    if action not in {ACTION_CAPTURE_FAILURE, ACTION_NATIVE_INIT_FAILURE}:
        return
    from docker_volume_capture_failure_reconcile import (
        MAX_LOG_BYTES,
        MAX_RECORD_BYTES,
        _capture_logs,
        _capture_native_init_failure_logs,
        _container_state,
        validate_capture_log_streams,
        validate_native_init_failure_log_streams,
    )
    archive = record.get("capture_logs")
    if not isinstance(archive, dict) or set(archive) != {"stdout", "stderr"}:
        raise BuildControlError("Pre-API failure checkpoint has no exact log archive")
    streams = {key: base64.b64decode(value, validate=True) for key, value in archive.items()}
    limit = 128 * 1024 if action == ACTION_CAPTURE_FAILURE else MAX_LOG_BYTES
    if sum(map(len, streams.values())) > limit:
        raise BuildControlError("Pre-API failure log archive exceeds its bound")
    if len(canonical(record)) + 1 > MAX_RECORD_BYTES:
        raise BuildControlError("Pre-API failure record exceeds its control-volume bound")
    state = {"started_at": record["started_at"], "finished_at": record["capture_finished_at"]}
    expected_exit = _expected_exit(record)
    if action == ACTION_CAPTURE_FAILURE:
        validate_capture_log_streams(streams, state)
        capture_logs = _capture_logs
    else:
        record_state = record.get("state")
        record_finished_at = record.get("finished_at")
        if (record_state == "planned" and record_finished_at is not None
                or record_state == "stopped-confirmed"
                and record_finished_at != record.get("capture_finished_at")
                or record_state not in {"planned", "stopped-confirmed"}):
            raise BuildControlError("Native initialization failure times differ from the exact container exit")
        validate_native_init_failure_log_streams(streams, state)
        capture_logs = _capture_native_init_failure_logs
    if actual is not None:
        actual_state = _container_state(actual, expected_exit=expected_exit)
        if (actual_state["started_at"] != record["started_at"]
                or actual_state["finished_at"] != record["capture_finished_at"]
                or capture_logs(actual["Id"], actual_state) != streams):
            raise BuildControlError("Pre-API failure log archive differs from the stopped namespace")


def checkpoint_capture(args):
    """Record an already stopped exact pre-API failure; do not start or stop it."""
    from docker_dev import _select_source, _compose_identity
    from docker_volume_dev import _validate_retained_service
    from docker_volume_capture_failure_reconcile import (
        _capture_logs,
        _container_state,
    )
    from docker_volume_pre_ack_retry import _publish_raw, _released_snapshot
    from docker_volume_accepted_reattach import _control_bytes
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    if (identity["project_name"] != "fullmag-master" or not re.fullmatch(r"[0-9a-f]{32}", args.attempt)
            or not re.fullmatch(r"[0-9a-f]{64}", args.backend_container_id)):
        raise BuildControlError("Capture checkpoint requires exact fullmag-master identities")
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    root = "development/attempts/" + args.attempt
    with control.operation("pre-api-capture-checkpoint", {"attempt": args.attempt,
                            "container_id": args.backend_container_id, "source_root": str(selected)}) as operation:
        previous_raw = _control_bytes(control, root + "/terminal.json")
        previous = json.loads(previous_raw)
        if (previous.get("phase") != "development" or previous.get("attempt") != args.attempt
                or previous.get("state") != "failed-confirmed" or previous.get("compose_project") != control.project
                or previous.get("inputs", {}).get("source_root") != str(selected)
                or _control_bytes(control, "development/current.json") != previous_raw):
            raise BuildControlError("Capture checkpoint requires the current exact failed development terminal")
        document = control.read(root + "/compose.json")
        actual = _inspect("inspect", args.backend_container_id)
        state_document = actual.get("State")
        if (isinstance(state_document, dict)
                and type(state_document.get("ExitCode")) is int
                and state_document.get("ExitCode") == 1):
            _checkpoint_native_init_failure(
                args, control, selected, root, previous_raw, previous, document, actual, operation
            )
            return
        image_config = _inspect("image", "inspect", actual["Image"])["Config"]
        _validate_retained_service(document, actual, "backend", image_config)
        if actual["Image"] != previous["inputs"]["image_id"]:
            raise BuildControlError("Capture checkpoint image differs from the retained attempt")
        state = _container_state(actual)
        logs = _capture_logs(actual["Id"], state)
        if sum(map(len, logs.values())) > 128 * 1024:
            raise BuildControlError("Capture checkpoint logs exceed their bound")
        checkpoint, released = _checkpoint(control, previous), _released_snapshot(control, actual)
        record = {"schema": SCHEMA, "state": "planned", "action": ACTION_CAPTURE_FAILURE,
                  "attempt": args.attempt, "compose_project": control.project,
                  "control_namespace": control.namespace, "source_root": str(selected),
                  "config_sha256": _sha(canonical(document)), "container_id": actual["Id"],
                  "image_id": actual["Image"], "started_at": state["started_at"],
                  "capture_finished_at": state["finished_at"],
                  "capture_logs": {key: base64.b64encode(value).decode("ascii") for key, value in logs.items()},
                  "checkpoint": checkpoint, "released": released}
        # Nothing can be inferred from the old process tree alone. The exact
        # current stopped namespace and its capture-only log must remain bound.
        if (_container_state(_inspect("inspect", actual["Id"])) != state
                or _checkpoint(control, previous) != checkpoint
                or _released_snapshot(control, actual) != released):
            raise BuildControlError("Capture-only namespace/authority changed during checkpoint")
        _validate_capture_evidence(record, actual)
        intent_raw = canonical(record) + b"\n"
        _publish_raw(control, root + SUFFIX + "intent.json", intent_raw)
        record.update(state="stopped-confirmed", finished_at=state["finished_at"], exit_code=2,
                      intent_sha256=_sha(intent_raw))
        _publish_raw(control, root + SUFFIX + "receipt.json", canonical(record) + b"\n")
        operation["receipt"].update(state="succeeded", signal_issued=False,
                                     checkpoint_sha256=_sha(canonical(record) + b"\n"))
        print(json.dumps({"state": "stopped-confirmed", "action": record["action"], "signal_issued": False,
                          "container_id": actual["Id"], "receipt": root + SUFFIX + "receipt.json",
                          "receipt_sha256": _sha(canonical(record) + b"\n")}, indent=2))


def _checkpoint_native_init_failure(args, control, selected, root, previous_raw,
                                    previous, document, actual, operation):
    """Checkpoint only the exact stopped host-policy initialization traceback."""
    from docker_volume_dev import _validate_retained_service
    from docker_volume_capture_failure_reconcile import (
        MAX_LOG_BYTES,
        MAX_RECORD_BYTES,
        _capture_native_init_failure_logs,
        _container_state,
        validate_native_init_failure_log_streams,
    )
    from docker_volume_pre_ack_retry import _publish_raw, _released_snapshot
    from docker_volume_accepted_reattach import _control_bytes

    intent_path, receipt_path = root + SUFFIX + "intent.json", root + SUFFIX + "receipt.json"
    if (_control_bytes(control, intent_path, optional=True, maximum=MAX_PRE_API_FAILURE_RECORD_BYTES) is not None
            or _control_bytes(control, receipt_path, optional=True,
                              maximum=MAX_PRE_API_FAILURE_RECORD_BYTES) is not None):
        raise BuildControlError("A pre-API failure checkpoint already exists; do not replace it")

    def validate_terminal():
        current_raw = _control_bytes(control, root + "/terminal.json")
        current = json.loads(current_raw)
        if (current_raw != previous_raw
                or current.get("schema") != "fullmag.docker-build-operation.v1"
                or current.get("phase") != "development"
                or current.get("attempt") != args.attempt
                or current.get("state") != "failed-confirmed"
                or current.get("compose_project") != control.project
                or current.get("inputs", {}).get("source_root") != str(selected)
                or _control_bytes(control, "development/current.json") != current_raw):
            raise BuildControlError("Native-init checkpoint requires the exact current failed development terminal")
        inputs = current.get("inputs")
        if (not isinstance(inputs, dict) or inputs.get("image_id") != actual["Image"]
                or (current.get("config_sha256") is not None
                    and current.get("config_sha256") != _sha(canonical(document)))):
            raise BuildControlError("Native-init checkpoint backend image differs from the failed attempt")
        return current

    if (actual.get("Id") != args.backend_container_id
            or actual.get("Image") != previous.get("inputs", {}).get("image_id")):
        raise BuildControlError("Native-init checkpoint container/image identity differs")
    if (previous.get("backend_container") is not None
            and previous.get("backend_container") != actual["Id"]):
        raise BuildControlError("Native-init checkpoint container differs from the failed attempt")
    validate_terminal()
    compose_raw = _control_bytes(control, root + "/compose.json")
    if json.loads(compose_raw) != document:
        raise BuildControlError("Native-init checkpoint Compose snapshot changed")
    namespace_key = "x-fullmag-control-namespace"
    if (document.get("name") != control.project
            or (control.namespace and document.get(namespace_key) != control.namespace)
            or (not control.namespace and namespace_key in document)):
        raise BuildControlError("Native-init checkpoint Compose namespace differs")

    def observe():
        current_actual = _inspect("inspect", args.backend_container_id)
        if (current_actual.get("Id") != actual["Id"]
                or current_actual.get("Image") != actual["Image"]):
            raise BuildControlError("Native-init checkpoint container incarnation changed")
        image_document = _inspect("image", "inspect", current_actual["Image"])
        if (image_document.get("Id") != current_actual["Image"]
                or not isinstance(image_document.get("Config"), dict)):
            raise BuildControlError("Native-init checkpoint image is not the exact immutable image")
        _validate_retained_service(document, current_actual, "backend", image_document["Config"])
        current_state = _container_state(current_actual, expected_exit=1)
        current_logs = _capture_native_init_failure_logs(current_actual["Id"], current_state)
        validate_native_init_failure_log_streams(current_logs, current_state)
        if sum(map(len, current_logs.values())) > MAX_LOG_BYTES:
            raise BuildControlError("Native-init checkpoint logs exceed their raw-byte bound")
        current_checkpoint = _checkpoint(control, previous)
        current_released = _released_snapshot(control, current_actual)
        return current_actual, current_state, current_logs, current_checkpoint, current_released

    first_actual, first_state, first_logs, checkpoint, released = observe()
    if (first_actual["Image"] != previous["inputs"]["image_id"]
            or compose_raw != _control_bytes(control, root + "/compose.json")):
        raise BuildControlError("Native-init checkpoint source/Compose/image identity changed")
    record = {
        "schema": SCHEMA,
        "state": "planned",
        "action": ACTION_NATIVE_INIT_FAILURE,
        "attempt": args.attempt,
        "compose_project": control.project,
        "control_namespace": control.namespace,
        "source_root": str(selected),
        "config_sha256": _sha(canonical(document)),
        "development_terminal_sha256": _sha(previous_raw),
        "container_id": first_actual["Id"],
        "image_id": first_actual["Image"],
        "started_at": first_state["started_at"],
        "capture_finished_at": first_state["finished_at"],
        "capture_logs": {
            key: base64.b64encode(value).decode("ascii") for key, value in first_logs.items()
        },
        "checkpoint": checkpoint,
        "released": released,
    }
    if len(canonical(record)) + 1 > MAX_RECORD_BYTES:
        raise BuildControlError("Native-init checkpoint exceeds its bounded control record")
    _validate_capture_evidence(record, first_actual)

    second_previous_raw = _control_bytes(control, root + "/terminal.json")
    second_document_raw = _control_bytes(control, root + "/compose.json")
    second_actual, second_state, second_logs, second_checkpoint, second_released = observe()
    validate_terminal()
    if (second_previous_raw != previous_raw or second_document_raw != compose_raw
            or second_state != first_state or second_logs != first_logs
            or second_checkpoint != checkpoint or second_released != released
            or second_actual["Id"] != first_actual["Id"]
            or second_actual["Image"] != first_actual["Image"]):
        raise BuildControlError("Native-init checkpoint observations changed; no evidence was published")
    _validate_capture_evidence(record, second_actual)
    if (_control_bytes(control, intent_path, optional=True,
                       maximum=MAX_PRE_API_FAILURE_RECORD_BYTES) is not None
            or _control_bytes(control, receipt_path, optional=True,
                              maximum=MAX_PRE_API_FAILURE_RECORD_BYTES) is not None):
        raise BuildControlError("A pre-API failure checkpoint appeared during observation")

    intent_raw = canonical(record) + b"\n"
    receipt_record = dict(
        record,
        state="stopped-confirmed",
        finished_at=second_state["finished_at"],
        exit_code=1,
        intent_sha256=_sha(intent_raw),
    )
    receipt_raw = canonical(receipt_record) + b"\n"
    if len(intent_raw) > MAX_DOCUMENT_BYTES or len(receipt_raw) > MAX_DOCUMENT_BYTES:
        raise BuildControlError("Native-init checkpoint intent or terminal receipt exceeds the control-document bound")
    _publish_raw(control, intent_path, intent_raw, maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
    _publish_raw(control, receipt_path, receipt_raw, maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
    operation["receipt"].update(
        state="succeeded", action=ACTION_NATIVE_INIT_FAILURE, signal_issued=False,
        checkpoint_sha256=_sha(receipt_raw),
    )
    print(json.dumps({"state": "stopped-confirmed", "action": ACTION_NATIVE_INIT_FAILURE,
                      "signal_issued": False, "container_id": first_actual["Id"],
                      "receipt": receipt_path, "receipt_sha256": _sha(receipt_raw)}, indent=2))


def retained_context(control, previous, document, backend_id, *, fresh_state, removed_container_proof=None):
    """Carry the same first pre-ACK authority after one proved pre-API stop."""
    from docker_volume_pre_ack_retry import _released_snapshot
    if not previous.get("attempt"):
        return None
    root = "development/attempts/" + previous["attempt"] + SUFFIX
    record = control.read(root + "receipt.json", optional=True)
    if record is None:
        if control.read(root + "intent.json", optional=True) is not None:
            raise BuildControlError("Pre-API stop has no confirmed outcome")
        return None
    if (fresh_state or previous.get("state") != "failed-confirmed"
            or record.get("schema") != SCHEMA or record.get("state") != "stopped-confirmed"
            or record.get("attempt") != previous["attempt"]
            or record.get("compose_project") != control.project
            or record.get("control_namespace") != control.namespace
            or record.get("source_root") != previous["inputs"]["source_root"]
            or record.get("config_sha256") != _sha(canonical(document))
            or record.get("container_id") != backend_id):
        raise BuildControlError("Retained pre-API stop identity differs")
    if record.get("action") == ACTION_NATIVE_INIT_FAILURE:
        from docker_volume_accepted_reattach import _control_bytes
        terminal_raw = _control_bytes(control, "development/attempts/" + previous["attempt"] + "/terminal.json",
                                      maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
        current_raw = _control_bytes(control, "development/current.json",
                                     maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
        if (_sha(terminal_raw) != record.get("development_terminal_sha256")
                or current_raw != terminal_raw or json.loads(terminal_raw) != previous):
            raise BuildControlError("Retained native-init failure differs from its exact current development terminal")
    from docker_volume_accepted_reattach import _control_bytes
    intent_raw = _control_bytes(control, root + "intent.json", maximum=MAX_PRE_API_FAILURE_RECORD_BYTES)
    base = {key: value for key, value in record.items() if key not in {"finished_at", "exit_code", "intent_sha256"}}
    base["state"] = "planned"
    expected_exit = _expected_exit(record)
    if (record.get("exit_code") != expected_exit or record.get("intent_sha256") != _sha(intent_raw)
            or json.loads(intent_raw) != base):
        raise BuildControlError("Retained pre-API receipt is not bound to its exact intent")
    if removed_container_proof is None:
        actual = _inspect("inspect", backend_id)
    else:
        # The existing resume caller has already validated this closed proof
        # and Docker absence. Bind its archived full observation again here.
        proof = removed_container_proof
        operation_id = proof.get("recreation_operation_id", "")
        if (proof.get("schema") != "fullmag.docker-removed-recreation-container.v1"
                or not re.fullmatch(r"[0-9a-f]{32}", operation_id)
                or proof.get("container_id") != backend_id or proof.get("image_id") != record["image_id"]):
            raise BuildControlError("Removed pre-API namespace proof identity differs")
        snapshot_raw = _control_bytes(control, "recreate-services/attempts/" + operation_id + "/retained-containers.json")
        if (proof.get("retained_snapshot_sha256") != _sha(snapshot_raw)
                or proof.get("prior_terminal_sha256") != _sha(_control_bytes(control,
                    "development/attempts/" + previous["attempt"] + "/terminal.json"))
                or proof.get("prior_compose_sha256") != _sha(_control_bytes(control,
                    "development/attempts/" + previous["attempt"] + "/compose.json"))):
            raise BuildControlError("Removed pre-API namespace archive differs")
        actual = json.loads(snapshot_raw)["backend"]
        if proof.get("container_state") != {
                "id": backend_id, "image": record["image_id"], "started_at": record["started_at"],
                "finished_at": record["finished_at"], "exit_code": expected_exit}:
            raise BuildControlError("Removed pre-API namespace incarnation differs")
    state = actual["State"]
    if record.get("action") in {ACTION_CAPTURE_FAILURE, ACTION_NATIVE_INIT_FAILURE}:
        from docker_volume_capture_failure_reconcile import _container_state
        archived_state = _container_state(actual, expected_exit=expected_exit)
        if (archived_state["id"] != backend_id
                or archived_state["image"] != record["image_id"]
                or archived_state["started_at"] != record["started_at"]
                or archived_state["finished_at"] != record["finished_at"]):
            raise BuildControlError("Retained pre-API archive differs from the exact stopped incarnation")
    if (actual["Id"] != backend_id or actual["Image"] != record["image_id"]
            or state["Running"] is not False or state["Status"] != "exited" or state["Pid"] != 0
            or state["OOMKilled"] is not False or state["ExitCode"] != record["exit_code"]
            or state["StartedAt"] != record["started_at"] or state["FinishedAt"] != record["finished_at"]):
        raise BuildControlError("Retained pre-API stopped incarnation differs")
    _validate_capture_evidence(record, actual if removed_container_proof is None else None)
    if _checkpoint(control, previous) != record["checkpoint"] or _released_snapshot(control, actual) != record["released"]:
        raise BuildControlError("Retained pre-API owner/config/held-run authority changed")
    metadata = record["checkpoint"]["native_restart_metadata"]
    return PreApiContext(previous_config_sha256=metadata["previous_config_sha256"],
                         native_restart_metadata=metadata)
