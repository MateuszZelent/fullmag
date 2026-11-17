"""Qualify the known OCI certificate-file mount refusal before PID 1."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from docker_build_control import (BuildControl, BuildControlError, bounded_capture,
    canonical, docker_capture, toolchain_configuration)
from docker_volume_reconcile import (SCHEMA as STANDARD, SHA, TOKEN, digest, fingerprint,
    read_raw, require, write_immutable)

SCHEMA = "fullmag.docker-resume-certificate-mount-refusal.v1"
PARENT_SCHEMA = "fullmag.docker-development-interrupted.v1"
PARENT_ERROR = "Development interrupted before package handoff; producer exit status unavailable"
CERTIFICATE_TARGET = "/run/fullmag/linux-native-host.json"
ERROR_MARKERS = ("OCI runtime create failed", "error during container init", "error mounting",
    CERTIFICATE_TARGET, "not a directory")
ABSENT_CONTROL_FILES = (
    "backend/runtime-provenance.json",
    "runtime-control/runtime-service/process-tree.json",
    "runtime-control/runtime-service/docker-all.json",
    "runtime-control/runtime-services/OWNER.json",
    "runtime-control/runtime-services/LAUNCH.json",
    "runtime-control/runtime-services/OWNER.lock",
)
ABSENT_ATTEMPT_FILES = (
    "backend-build-receipt.json", "provenance.json",
    "storage-probe-log.json", "worker-cgroup-compose.json", "worker-cgroup-log.json",
    "handoff-log.json", "docker_worker_cgroup.py",
)
STATE_FILES = (".fullmag-linux-native-owner.json", ".linux-native-sentinel", "linux-native-host.json")
CONTROLLERS = (
    "docker_volume_reconcile.py", "docker_volume_resume_mount_refusal.py",
    "docker_volume_resume_layout_refusal.py",
    "docker_stopped_network.py",
    "docker_volume_activation_reconcile.py", "docker_build_control.py",
    "docker_volume_dev.py", "docker_volume_development_interrupted.py",
    "docker_group_storage.py", "docker_dev_host.py", "linux_native_host.py",
    "docker_volume_toolchain_reconcile.py", "fullmag_storage.py",
)


def parent_request_path(attempt, request_sha256):
    require(TOKEN.fullmatch(attempt) is not None and SHA.fullmatch(request_sha256) is not None,
        "Invalid parent request identity")
    return "verification/development-interrupted/" + attempt + "/" + request_sha256 + "/request.json"


def validate_mount_error(error):
    require(isinstance(error, str) and len(error) <= 16384
        and all(marker.casefold() in error.casefold() for marker in ERROR_MARKERS),
        "Backend error is not the pinned OCI certificate-file mount refusal")
    target_context = re.compile(
        r"\bto rootfs at\s+[\"']?/run/fullmag/linux-native-host\.json[\"']?(?=[:\s]|$)", re.I)
    require(target_context.search(error) is not None,
        "OCI error does not identify the certificate path as the rejected mount target")


def validate_shape(request):
    require(isinstance(request, dict) and set(request) == {
        "schema", "attempt", "compose_project", "source_root", "port", "config_sha256",
        "unknown_receipt_sha256", "controller_sha256", "containers", "failure"},
        "Certificate mount refusal request keys differ")
    standard = {key: value for key, value in request.items() if key != "failure"}
    standard.update(schema=STANDARD, package_documents={"receipt": "0" * 64, "provenance": "0" * 64})
    from docker_volume_reconcile import validate_request
    validate_request(standard)
    require(request["schema"] == SCHEMA, "Certificate mount refusal schema differs")
    proof = request["failure"]
    require(isinstance(proof, dict) and set(proof) == {
        "error", "error_sha256", "parent", "certificate", "compose_sha256", "private_owner_sha256",
        "frontend_inputs_sha256", "frontend_seed_sha256", "helper_log_sha256", "service_states", "engine_id", "active_sha256",
        "current_sha256", "verified_sha256", "absent_control_files", "absent_attempt_files",
        "state_files", "controllers"}, "Certificate mount refusal proof keys differ")
    validate_mount_error(proof["error"])
    require(SHA.fullmatch(proof["error_sha256"]) is not None
        and digest(proof["error"].encode("utf-8")) == proof["error_sha256"],
        "Original OCI error digest differs")
    parent = proof["parent"]
    require(isinstance(parent, dict) and set(parent) == {
        "attempt", "request_path", "request_sha256", "receipt_sha256", "terminal_sha256",
        "compose_sha256", "config_sha256", "source_root", "compose_project", "control_volume",
        "image_id", "controller_sha256", "controller_inputs_sha256"},
        "Parent pre-handoff request identity differs")
    require(isinstance(parent["attempt"], str) and TOKEN.fullmatch(parent["attempt"])
        and parent["attempt"] != request["attempt"]
        and parent["request_path"] == parent_request_path(parent["attempt"], parent["request_sha256"]),
        "Parent pre-handoff request path differs")
    for key in ("request_sha256", "receipt_sha256", "terminal_sha256", "compose_sha256", "config_sha256",
                "controller_sha256", "controller_inputs_sha256"):
        require(isinstance(parent[key], str) and SHA.fullmatch(parent[key]), "Invalid parent digest: " + key)
    require(parent["source_root"] == request["source_root"]
        and parent["compose_project"] == request["compose_project"]
        and parent["config_sha256"] == request["config_sha256"]
        and parent["image_id"] == request["containers"]["backend"]["image"],
        "Parent source, project, config or image differs")
    require(isinstance(parent["control_volume"], str) and bool(parent["control_volume"])
        and isinstance(parent["image_id"], str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", parent["image_id"]),
        "Parent control volume or image identity is missing")
    certificate = proof["certificate"]
    require(isinstance(certificate, dict) and set(certificate) == {"path", "sha256", "inode", "device"}
        and isinstance(certificate["path"], str) and Path(certificate["path"]).is_absolute()
        and SHA.fullmatch(certificate["sha256"]) is not None
        and type(certificate["inode"]) is int and certificate["inode"] > 0
        and type(certificate["device"]) is int and certificate["device"] > 0,
        "Retained host certificate identity is invalid")
    for key in ("compose_sha256", "private_owner_sha256", "frontend_inputs_sha256", "frontend_seed_sha256", "helper_log_sha256"):
        require(isinstance(proof[key], str) and SHA.fullmatch(proof[key]), "Invalid refusal digest: " + key)
    for key in ("current_sha256", "verified_sha256"):
        require(proof[key] is None or isinstance(proof[key], str) and SHA.fullmatch(proof[key]),
            "Invalid resume pointer pin")
    require(isinstance(proof["engine_id"], str) and bool(proof["engine_id"]), "Missing Docker engine identity")
    require(isinstance(proof["active_sha256"], str) and SHA.fullmatch(proof["active_sha256"]),
        "Active resume owner digest is missing")
    for key in ("absent_control_files", "absent_attempt_files"):
        expected = set(ABSENT_CONTROL_FILES if key == "absent_control_files" else ABSENT_ATTEMPT_FILES)
        require(isinstance(proof[key], dict) and set(proof[key]) == expected
            and all(value is None for value in proof[key].values()), "Runtime/publication absence pins differ: " + key)
    require(isinstance(proof["state_files"], dict) and set(proof["state_files"]) == set(STATE_FILES)
        and all(isinstance(value, str) and SHA.fullmatch(value) for value in proof["state_files"].values()),
        "Retained host state files are not exactly pinned")
    for key, names in (("service_states", {"backend", "frontend"}), ("controllers", set(CONTROLLERS))):
        require(isinstance(proof[key], dict) and set(proof[key]) == names
            and all(isinstance(value, str) and SHA.fullmatch(value) for value in proof[key].values()),
            "Incomplete failure evidence: " + key)
    require(proof["controllers"]["docker_volume_reconcile.py"] == request["controller_sha256"],
        "Dispatcher controller pin differs")


def _timestamp_ns(value):
    from docker_volume_development_interrupted import _docker_timestamp_ns
    try:
        return _docker_timestamp_ns(value)
    except (ValueError, TypeError, OverflowError) as error:
        raise BuildControlError("Docker service timestamp is invalid") from error


def validate_original(original, actual):
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
        and original.get("phase") == "resume"
        and original.get("state") == "outcome-unknown-resources-retained"
        and isinstance(original.get("started_at"), (int, float))
        and not isinstance(original.get("started_at"), bool)
        and original.get("helper_container") == "fullmag-control-" + original.get("attempt", ""),
        "Original OCI-refused resume receipt differs")
    validate_mount_error(original.get("error"))
    require(isinstance(actual, dict) and set(actual) == {"backend", "frontend", "lease"},
        "Exact backend, frontend and original helper observations are required")
    for name, exit_code in (("backend", 127), ("frontend", 255)):
        observed = actual[name]
        state = observed.get("State", {})
        require(observed.get("Id") == original.get(name + "_container")
            and state.get("StartedAt") == original.get(name + "_started_at"),
            "Service ID/StartedAt differs from the resume receipt: " + name)
        require(state.get("Status") == "exited" and state.get("Running") is False
            and state.get("Pid") == 0 and state.get("ExitCode") == exit_code
            and all(state.get(key) is False for key in ("OOMKilled", "Dead", "Restarting", "Paused")),
            "OCI refusal requires the exact stopped service exit: " + name)
        require(_timestamp_ns(state.get("FinishedAt")) < int(original["started_at"] * 1_000_000_000),
            "Service finished during or after the refused resume: " + name)
        if name == "backend":
            validate_mount_error(state.get("Error"))
        else:
            require(state.get("Error") in (None, ""), "Frontend has an unrelated daemon error")
    parent = original.get("inputs", {}).get("attempt")
    require(isinstance(parent, str) and TOKEN.fullmatch(parent)
        and parent != original.get("attempt"), "Resume parent attempt is missing")
    require(all(original.get(key) is None for key in (
        "prestart_reconciliation", "terminal_prestart_reconciliation", "worker_cgroup",
        "worker_cgroup_helper", "saved_authoring_restore_required")),
        "Resume crossed a separate admission/recovery boundary")


def validate_absence(actual):
    require(isinstance(actual, dict) and set(actual) == set(ABSENT_CONTROL_FILES)
        and all(value is None for value in actual.values()),
        "Native runtime owner/process/provenance evidence is present")


def validate_certificate_owner(certificate_raw, owner_raw):
    try:
        certificate = json.loads(certificate_raw)
        owner = json.loads(owner_raw)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as error:
        raise BuildControlError("Retained native host certificate/owner is invalid JSON") from error
    require(isinstance(certificate, dict) and certificate == owner
        and certificate.get("schema") == "fullmag.linux-native-host.v1"
        and certificate.get("storage_profile") == "linux-native-v1",
        "Retained Linux host certificate and owner differ")
    return certificate


def validate_parent_log(raw, parent_request):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 32 * 1024 * 1024
        and digest(raw) == parent_request.get("backend_log_sha256"),
        "Parent backend log changed or exceeds its observation bound")
    require(b"phase=start state=handoff" not in raw and b"phase=api state=exec" not in raw,
        "Parent backend log proves package handoff or API execution")


def validate_parent_record(request, original, terminal, parent_request, parent_unknown_raw,
                           compose_raw, document, source, project, volume):
    from docker_volume_development_interrupted import validate_request as validate_parent_request
    validate_parent_request(parent_request)
    proof = request["failure"]["parent"]
    reconciliation = terminal.get("reconciliation", {})
    require(parent_request.get("schema") == PARENT_SCHEMA
        and parent_request.get("attempt") == proof["attempt"]
        and parent_request.get("source_root") == str(source) == proof["source_root"]
        and parent_request.get("compose_project") == project == proof["compose_project"]
        and parent_request.get("receipt_sha256") == proof["receipt_sha256"]
        and parent_request.get("compose_sha256") == proof["compose_sha256"] == digest(compose_raw)
        and digest(canonical(document)) == proof["config_sha256"] == request["config_sha256"]
        and digest(parent_unknown_raw) == parent_request["receipt_sha256"],
        "Parent request, unknown receipt, source or Compose identity differs")
    archived_controllers = digest(canonical(parent_request["controller_inputs"]))
    require(parent_request.get("controller_sha256") == proof["controller_sha256"]
        and archived_controllers == proof["controller_inputs_sha256"],
        "Archived parent controller identity differs")
    require(terminal.get("schema") == "fullmag.docker-build-operation.v1"
        and terminal.get("phase") == "development" and terminal.get("state") == "failed-confirmed"
        and terminal.get("attempt") == proof["attempt"]
        and terminal.get("compose_project") == project and terminal.get("control_volume") == volume
        and terminal.get("error") == PARENT_ERROR
        and terminal.get("state_root") == original.get("state_root")
        and terminal.get("backend_volumes") == original.get("backend_volumes")
        and terminal.get("frontend_volume") == original.get("frontend_volume")
        and terminal.get("config_sha256") == proof["config_sha256"]
        and reconciliation.get("schema") == PARENT_SCHEMA
        and reconciliation.get("request_sha256") == proof["request_sha256"]
        and reconciliation.get("original_receipt_sha256") == parent_request["receipt_sha256"]
        and terminal.get("backend_container") == original.get("backend_container")
        and terminal.get("frontend_container") == original.get("frontend_container"),
        "Parent is not the exact completed pre-handoff interruption")
    require(proof["request_sha256"] == digest(canonical(parent_request) + b"\n")
        and proof["terminal_sha256"] == digest(canonical(terminal) + b"\n")
        and original.get("inputs", {}).get("attempt") == proof["attempt"]
        and original.get("inputs", {}).get("config_sha256") == proof["config_sha256"]
        and original.get("inputs", {}).get("source_root") == str(source)
        and original.get("inputs", {}).get("image_id") == proof["image_id"]
        and all(parent_request["containers"][name]["id"] == request["containers"][name]["id"]
            and parent_request["containers"][name]["image"] == request["containers"][name]["image"]
            and parent_request["containers"][name]["fingerprint"] == request["containers"][name]["fingerprint"]
            for name in ("backend", "frontend")),
        "Resume is not linked to the exact failed pre-handoff parent services")
    require(proof["control_volume"] == volume == original.get("control_volume")
        and proof["image_id"] == request["containers"]["backend"]["image"]
        and document.get("name") == project and set(document.get("services", {})) == {"backend", "frontend"}
        and document["services"]["backend"].get("environment", {}).get("FULLMAG_STARTUP_ENABLED") != "1"
        and document["services"]["backend"].get("environment", {}).get("FULLMAG_SESSION_STORAGE_PROFILE") == "linux-native-v1"
        and all(document["services"][name].get("image") == request["containers"][name]["image"]
            for name in ("backend", "frontend")),
        "Parent Compose service, image or startup contract differs")


def validate_parent(control, request, original, terminal, document, source,
                    parent_request_raw, terminal_raw, compose_raw, parent_unknown_raw):
    proof = request["failure"]["parent"]
    require(digest(parent_request_raw) == proof["request_sha256"]
        and parent_request_raw == canonical(json.loads(parent_request_raw)) + b"\n"
        and digest(terminal_raw) == proof["terminal_sha256"]
        and digest(compose_raw) == proof["compose_sha256"],
        "Archived parent request/terminal/Compose CAS differs")
    parent_request = json.loads(parent_request_raw)
    validate_parent_record(request, original, terminal, parent_request, parent_unknown_raw,
        compose_raw, document, source, control.project, control.volume)
    return parent_request


def _state_file_pins(state):
    root = Path(state)
    require(root.is_dir() and not root.is_symlink() and root.resolve(strict=True) == root,
        "Retained Linux state root is missing or linked")
    expected = set(STATE_FILES)
    files = {}
    visited = 0
    pending = [root]
    while pending:
        parent = pending.pop()
        try:
            entries = list(os.scandir(parent))
        except OSError as error:
            raise BuildControlError("Cannot inspect retained Linux state root") from error
        visited += len(entries)
        require(visited <= 4096 and len(parent.relative_to(root).parts) <= 32,
            "Retained Linux state root exceeds the bounded inventory")
        for entry in entries:
            info = entry.stat(follow_symlinks=False)
            require(not stat.S_ISLNK(info.st_mode), "Retained Linux state contains a symlink")
            if stat.S_ISDIR(info.st_mode):
                pending.append(Path(entry.path))
                continue
            rel = Path(entry.path).relative_to(root).as_posix()
            require(stat.S_ISREG(info.st_mode) and rel in expected and info.st_nlink == 1,
                "Retained Linux state contains unexpected file data: " + rel)
            try:
                raw = Path(entry.path).read_bytes()
            except OSError as error:
                raise BuildControlError("Cannot read retained Linux identity file: " + rel) from error
            files[rel] = digest(raw)
    require(set(files) == expected, "Retained Linux certificate, owner and sentinel set differs")
    return files


def validate_empty_session_store(state_root):
    from docker_volume_development_interrupted import _require_empty_run_store
    _require_empty_run_store(Path(state_root) / "runs" / "docker-all")


def _validate_host_certificate(request, document, state):
    import docker_volume_dev as dev
    proof = request["failure"]
    path = dev._certificate_path(state)
    resolved = path.resolve(strict=True)
    info = path.lstat()
    host = dev._session_host()
    certificate_raw = host.read_owned_regular(path)
    owner_raw = host.read_owned_regular(Path(state) / host.OWNER_NAME)
    certificate = validate_certificate_owner(certificate_raw, owner_raw)
    sentinel_path = Path(state) / ".linux-native-sentinel"
    sentinel = host.read_owned_regular(sentinel_path)
    expected_sentinel = (certificate.get("owner_token", "") + ":" + certificate.get("image_id", "")).encode("ascii")
    require(bool(certificate.get("owner_token")) and sentinel == expected_sentinel
        and hashlib.sha256(sentinel).hexdigest() == certificate.get("restart_expected_sha256"),
        "Retained Linux owner sentinel differs")
    cert_pin = proof["certificate"]
    mounts = [mount for mount in document["services"]["backend"].get("volumes", [])
        if isinstance(mount, dict) and mount.get("target") == CERTIFICATE_TARGET]
    require(len(mounts) == 1 and mounts[0].get("type") == "bind"
        and mounts[0].get("read_only") is True
        and Path(mounts[0].get("source", "")).resolve(strict=True) == resolved
        and cert_pin == {"path": str(resolved), "sha256": digest(certificate_raw),
            "inode": info.st_ino, "device": info.st_dev},
        "Physical host certificate path/hash/inode/device differs from the retained Compose bind")
    dev._retained_certificate(state, document)
    return {".fullmag-linux-native-owner.json": digest(owner_raw),
        ".linux-native-sentinel": digest(sentinel), "linux-native-host.json": digest(certificate_raw)}


def validate_service_state_pins(request, actual):
    require({name: digest(canonical(actual[name]["State"])) for name in ("backend", "frontend")}
        == request["failure"]["service_states"], "Stopped service state changed after the OCI refusal")


def validate_frontend_seed(seed_raw, inputs_raw, request):
    """Metadata is seeded before Compose start; it is not API admission evidence."""
    seeded, inputs = json.loads(seed_raw), json.loads(inputs_raw)
    require(isinstance(inputs, dict) and isinstance(inputs.get("files"), list)
        and inputs.get("source_root") == request["source_root"]
        and inputs.get("host_port") == request["port"]
        and isinstance(seeded, dict) and set(seeded) == {"state", "files"}
        and seeded.get("state") == "seeded" and type(seeded.get("files")) is int
        and seeded["files"] == len(inputs["files"]) > 0,
        "Frontend seed does not match the pinned checkout, port and metadata files")


def validate_helper_identity(actual, helper_id, pin):
    require(actual.get("Id") == helper_id and actual.get("State", {}).get("Running") is True
        and fingerprint(actual) == pin["fingerprint"] and actual.get("State", {}).get("StartedAt") == pin["started_at"],
        "Original live resume helper identity differs")


def validate_operation_lock(control, attempt):
    path = control.path("operation.lock")
    script = (f"test -f '{path}'; test ! -L '{path}'; exec 8<>'{path}'; "
        "if flock -n 8; then exit 42; else exit 0; fi")
    result = bounded_capture(control.helper_args(script), data=b"", timeout=30)
    require(result.returncode == 0, "Original helper no longer owns operation.lock for " + attempt)


def validate_partial_current(control, root, request):
    """Allow only the exact prepared result after current moved but before terminal."""
    proof = request["failure"]
    current = read_raw(control, "resume/current.json", optional=True)
    current_sha = digest(current) if current is not None else None
    if current_sha == proof["current_sha256"]:
        return current
    pending = read_raw(control, root + "/receipt.json")
    value = json.loads(pending)
    request_sha = digest(canonical(request) + b"\n")
    terminal = read_raw(control, root + "/terminal.json", optional=True)
    require(current == pending and value.get("schema") == "fullmag.docker-build-operation.v1"
        and value.get("phase") == "resume" and value.get("attempt") == request["attempt"]
        and value.get("state") == "failed-confirmed" and value.get("error") == proof["error"]
        and value.get("certificate_mount_refusal_proof") == proof
        and value.get("reconciliation", {}).get("request_sha256") == request_sha
        and value.get("reconciliation", {}).get("unknown_receipt_sha256") == request["unknown_receipt_sha256"]
        and terminal in (None, pending),
        "Changed resume/current pointer has no exact pending mount-refusal result")
    return current


def validate_failure(control, root, request, original, actual, state):
    from docker_volume_activation_reconcile import _validate_helper, _validate_helper_logged
    import docker_group_storage
    import docker_volume_dev as dev
    proof = request["failure"]
    source = Path(request["source_root"])
    require(original.get("attempt") == request["attempt"]
        and original.get("compose_project") == control.project
        and original.get("control_volume") == control.volume
        and original.get("inputs", {}).get("source_root") == str(source),
        "Original resume attempt/source/group differs")
    from docker_volume_reconcile import validate_incarnation
    for name, pin in request["containers"].items():
        validate_incarnation(actual[name], pin, control.project, running=(name == "lease"))
    for name, sha in proof["controllers"].items():
        require(digest((source / "scripts" / name).read_bytes()) == sha,
            "Failure controller changed: " + name)
    require(docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip() == proof["engine_id"],
        "Docker engine changed")
    validate_original(original, actual)
    parent = proof["parent"]
    parent_root = "development/attempts/" + parent["attempt"]
    parent_request_raw = read_raw(control, parent["request_path"])
    terminal_raw = read_raw(control, parent_root + "/terminal.json")
    compose_raw = read_raw(control, parent_root + "/compose.json")
    parent_unknown_raw = read_raw(control, parent_root + "/unknown-receipt.json")
    parent_terminal = json.loads(terminal_raw)
    document = json.loads(compose_raw)
    parent_request = validate_parent(control, request, original, parent_terminal, document, source,
        parent_request_raw, terminal_raw, compose_raw, parent_unknown_raw)
    require(digest(compose_raw) == proof["compose_sha256"], "Retained Compose changed")
    for name, sha in parent_request["attempt_documents"].items():
        require(digest(read_raw(control, parent_root + "/" + name)) == sha,
            "Archived parent attempt document changed: " + name)
    ports = document["services"]["frontend"].get("ports", [])
    require(len(ports) == 1 and str(ports[0].get("published")) == str(request["port"])
        and ports[0].get("host_ip") == "127.0.0.1", "Retained frontend loopback port differs")
    dev._operator_probe_record_from_retained(original, document)
    for path, key in (("private/.owner.json", "private_owner_sha256"),
        ("frontend/development-inputs.json", "frontend_inputs_sha256")):
        require(digest(read_raw(control, path)) == proof[key], "Retained group evidence changed: " + path)
    frontend_seed = read_raw(control, root + "/frontend-seed.json")
    require(digest(frontend_seed) == proof["frontend_seed_sha256"], "Resume frontend seed changed")
    validate_frontend_seed(frontend_seed, read_raw(control, "frontend/development-inputs.json"), request)
    require(json.loads(read_raw(control, "private/.owner.json"))
        == docker_group_storage.owner_manifest(control, source),
        "Private group storage owner is not authenticated")
    for path, expected in proof["absent_control_files"].items():
        require(read_raw(control, path, optional=True) is None and expected is None,
            "Native runtime publication evidence is present: " + path)
    for name, expected in proof["absent_attempt_files"].items():
        require(read_raw(control, root + "/" + name, optional=True) is None and expected is None,
            "Resume crossed package/admission publication: " + name)
    current_host_files = _validate_host_certificate(request, document, state)
    require(_state_file_pins(state) == proof["state_files"]
        and current_host_files == proof["state_files"], "Retained Linux state files changed")
    state_root = Path(state)
    require(state_root.resolve(strict=True) == state_root
        and state_root == Path(original["state_root"]).resolve(strict=True),
        "Retained Linux state root differs")
    validate_empty_session_store(state_root)
    active_raw = read_raw(control, "active")
    require(active_raw == (request["attempt"] + "\n").encode()
        and digest(active_raw) == proof["active_sha256"], "Active resume owner changed")
    host_identity = proof["certificate"]
    state_metadata = state_root.stat()
    require(state_metadata.st_dev == host_identity["device"], "Retained Linux state device differs")
    helper, helper_id = _validate_helper(control, original["helper_container"], request["attempt"], phase="resume")
    validate_helper_identity(helper, helper_id, request["containers"]["lease"])
    require(helper_id == actual["lease"]["Id"], "Original live helper differs from inspected lease")
    require(digest(_validate_helper_logged(helper_id).encode()) == proof["helper_log_sha256"],
        "Original live helper acknowledgement changed")
    validate_operation_lock(control, request["attempt"])
    validate_service_state_pins(request, actual)
    logs = docker_capture("logs", request["containers"]["backend"]["id"])
    validate_parent_log(logs.stdout + logs.stderr, parent_request)
    validate_partial_current(control, root, request)
    require(proof["verified_sha256"] == _optional_sha(control, "resume/verified.json"),
        "Last verified resume changed")
    require(parent_request.get("storage_certificate_sha256") == host_identity["sha256"],
        "Native host certificate differs from the original development receipt")
    require(request["containers"]["backend"]["image"] == parent_request["containers"]["backend"]["image"],
        "Resume backend image differs from archived parent")
    return dict(proof)


def _optional_sha(control, path):
    raw = read_raw(control, path, optional=True)
    return digest(raw) if raw is not None else None


def pointer_cas_script(control, request, result_sha):
    from docker_volume_resume_layout_refusal import pointer_cas_script as layout_pointer_cas
    return layout_pointer_cas(control, request, result_sha)


def verify_finalization(control, root, request, result_raw):
    for path in (root + "/receipt.json", root + "/terminal.json", "resume/current.json"):
        require(read_raw(control, path) == result_raw, "Failure-only publication differs: " + path)
    require(_optional_sha(control, "resume/verified.json") == request["failure"]["verified_sha256"],
        "Failure-only publication changed verified resume")


def wait_release(control, request):
    from docker_volume_resume_layout_refusal import wait_release as layout_wait_release
    layout_wait_release(control, request)


def completed(control, root, request, request_sha):
    raw = read_raw(control, root + "/terminal.json", optional=True)
    if raw is None:
        return False
    value = json.loads(raw)
    reconciliation = value.get("reconciliation", {})
    require(value.get("schema") == "fullmag.docker-build-operation.v1"
        and value.get("phase") == "resume" and value.get("attempt") == request["attempt"]
        and value.get("compose_project") == control.project and value.get("control_volume") == control.volume
        and value.get("state") == "failed-confirmed"
        and value.get("error") == request["failure"]["error"]
        and value.get("certificate_mount_refusal_proof") == request["failure"]
        and reconciliation.get("request_sha256") == request_sha
        and reconciliation.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"],
        "Completed certificate mount-refusal terminal identity differs")
    require(digest(read_raw(control, root + "/unknown-receipt.json")) == request["unknown_receipt_sha256"],
        "Completed refusal original receipt differs")
    journal = root + "/reconciliation/" + digest(raw)
    prepared = json.loads(read_raw(control, journal + "/prepared.json"))
    require(read_raw(control, journal + "/result.json") == raw
        and prepared.get("request_sha256") == request_sha
        and prepared.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"]
        and prepared.get("result_sha256") == digest(raw),
        "Completed refusal prepared journal differs")
    verify_finalization(control, root, request, raw)
    wait_release(control, request)
    return True


def publish_validated_request(control, request, original, actual, state):
    """Write the immutable request only after all read-only guards succeed."""
    validate_shape(request)
    root = "resume/attempts/" + request["attempt"]
    validate_failure(control, root, request, original, actual, state)
    raw = canonical(request) + b"\n"
    relative = "verification/resume-certificate-mount-refusal/" + request["attempt"] \
        + "/" + digest(raw) + "/request.json"
    write_immutable(control, relative, raw)
    return {"state": "request-pinned", "request": relative, "request_sha256": digest(raw)}


def build_request(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_activation_reconcile import _validate_helper, _validate_helper_logged
    import docker_volume_dev as dev
    require(TOKEN.fullmatch(args.attempt) is not None, "Exact resume attempt required")
    source, layout = _select_source(Path(args.source_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    image = toolchain_configuration(source, identity)["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, image)
    root = "resume/attempts/" + args.attempt
    original_raw = read_raw(control, root + "/receipt.json")
    original = json.loads(original_raw)
    parent_attempt = original.get("inputs", {}).get("attempt")
    require(isinstance(parent_attempt, str) and TOKEN.fullmatch(parent_attempt), "Exact pre-handoff parent is required")
    parent_root = "development/attempts/" + parent_attempt
    terminal_raw = read_raw(control, parent_root + "/terminal.json")
    terminal = json.loads(terminal_raw)
    compose_raw = read_raw(control, parent_root + "/compose.json")
    document = json.loads(compose_raw)
    parent_request_sha = terminal.get("reconciliation", {}).get("request_sha256")
    parent_path = parent_request_path(parent_attempt, parent_request_sha)
    parent_request_raw = read_raw(control, parent_path)
    parent_unknown_raw = read_raw(control, parent_root + "/unknown-receipt.json")
    parent_request = json.loads(parent_request_raw)
    helper, helper_id = _validate_helper(control, original.get("helper_container"), args.attempt, phase="resume")
    actual = {"lease": helper}
    ids = docker_capture("ps", "--all", "--no-trunc", "--filter",
        "label=com.docker.compose.project=" + control.project, "--format", "{{.ID}}").stdout.decode().split()
    require(len(ids) == 3, "Only the exact helper and two resumed application containers may remain")
    inspected = json.loads(docker_capture("inspect", *ids).stdout)
    services = {}
    for item in inspected:
        name = item.get("Config", {}).get("Labels", {}).get("com.docker.compose.service")
        if name in ("backend", "frontend"):
            require(name not in services, "Duplicate resumed service container")
            services[name] = item
        elif name == "build-control":
            require(item.get("Id") == helper_id, "Unexpected group helper remains")
        else:
            require(False, "Unexpected group container remains")
    require(set(services) == {"backend", "frontend"}, "Both resumed service containers are required")
    actual.update(services)
    validate_original(original, actual)
    cert_path = dev._certificate_path(Path(original["state_root"]))
    cert_raw = dev._session_host().read_owned_regular(cert_path)
    cert_stat = cert_path.lstat()
    certificate = {"path": str(cert_path.resolve(strict=True)), "sha256": digest(cert_raw),
        "inode": cert_stat.st_ino, "device": cert_stat.st_dev}
    current = _optional_sha(control, "resume/current.json")
    verified = _optional_sha(control, "resume/verified.json")
    proof = {"error": original["error"], "error_sha256": digest(original["error"].encode("utf-8")),
        "parent": {"attempt": parent_attempt, "request_path": parent_path,
            "request_sha256": digest(parent_request_raw), "receipt_sha256": parent_request["receipt_sha256"],
            "terminal_sha256": digest(terminal_raw), "compose_sha256": digest(compose_raw),
            "config_sha256": digest(canonical(document)), "source_root": str(source),
            "compose_project": control.project, "control_volume": control.volume,
            "image_id": parent_request["containers"]["backend"]["image"],
            "controller_sha256": parent_request["controller_sha256"],
            "controller_inputs_sha256": digest(canonical(parent_request["controller_inputs"]))},
        "certificate": certificate, "compose_sha256": digest(compose_raw),
        "private_owner_sha256": digest(read_raw(control, "private/.owner.json")),
        "frontend_inputs_sha256": digest(read_raw(control, "frontend/development-inputs.json")),
        "frontend_seed_sha256": digest(read_raw(control, root + "/frontend-seed.json")),
        "helper_log_sha256": digest(_validate_helper_logged(helper_id).encode()),
        "service_states": {name: digest(canonical(actual[name]["State"])) for name in ("backend", "frontend")},
        "engine_id": docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip(),
        "active_sha256": digest(read_raw(control, "active")),
        "current_sha256": current, "verified_sha256": verified,
        "absent_control_files": {path: None for path in ABSENT_CONTROL_FILES},
        "absent_attempt_files": {path: None for path in ABSENT_ATTEMPT_FILES},
        "state_files": _state_file_pins(Path(original["state_root"])),
        "controllers": {name: digest((source / "scripts" / name).read_bytes()) for name in CONTROLLERS}}
    request = {"schema": SCHEMA, "attempt": args.attempt, "source_root": str(source),
        "compose_project": control.project, "port": args.port,
        "config_sha256": digest(canonical(document)), "unknown_receipt_sha256": digest(original_raw),
        "controller_sha256": proof["controllers"]["docker_volume_reconcile.py"], "failure": proof,
        "containers": {name: {"id": value["Id"], "image": value["Image"],
            "started_at": value["State"]["StartedAt"], "fingerprint": fingerprint(value)}
            for name, value in actual.items()}}
    request["containers"]["lease"]["started_at"] = actual["lease"]["State"]["StartedAt"]
    return publish_validated_request(control, request, original, actual, Path(original["state_root"]))


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--source-root", required=True)
    value.add_argument("--attempt", required=True)
    value.add_argument("--port", required=True, type=int)
    return value


if __name__ == "__main__":
    print(json.dumps(build_request(parser().parse_args())))
