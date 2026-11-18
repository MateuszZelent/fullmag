"""Failure-only reconciliation for one admitted Linux-native resume OCI refusal.

This path never starts/stops application services or changes the saved session,
native-host owner, or group ledger. The original operation helper remains the
only process that releases ``/control/active`` after this script publishes the
exact failure terminal through the existing observer/commit protocol.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

from docker_build_control import (
    BuildControl,
    BuildControlError,
    canonical,
    docker_capture,
    toolchain_configuration,
)
from docker_volume_reconcile import (
    MOUNT_REFUSAL_SCHEMA,
    SCHEMA as RECONCILIATION_SCHEMA,
    SHA,
    TOKEN,
    claim_script as shared_claim_script,
    digest,
    fingerprint,
    read_raw,
    require,
    validate_original_owner,
    write_immutable,
)

import docker_volume_resume_mount_refusal as prehandoff_refusal


SCHEMA = "fullmag.docker-admitted-resume-certificate-mount-refusal.v1"
CERTIFICATE_TARGET = prehandoff_refusal.CERTIFICATE_TARGET
BASE_DOCUMENTS = (
    "backend-cache.json",
    "group-ledger.json",
    "frontend-seed.json",
    "cache-maintenance-compose.json",
)
PRESERVED_CONTROL_FILES = (
    "backend/runtime-provenance.json",
    "runtime-control/runtime-service/process-tree.json",
    "runtime-control/runtime-service/docker-all.json",
    "runtime-control/runtime-services/OWNER.json",
    "runtime-control/runtime-services/LAUNCH.json",
    "runtime-control/runtime-services/OWNER.lock",
    "private/.owner.json",
    "frontend/development-inputs.json",
)
CONTROLLERS = (
    "docker_volume_admitted_resume_mount_refusal.py",
    "docker_volume_reconcile.py",
    "docker_volume_resume_mount_refusal.py",
    "docker_volume_resume_layout_refusal.py",
    "docker_volume_activation_reconcile.py",
    "docker_volume_development_interrupted.py",
    "docker_build_control.py",
    "docker_volume_dev.py",
    "docker_group_storage.py",
    "docker_dev_host.py",
    "docker_compose_identity.py",
    "linux_native_host.py",
    "fullmag_storage.py",
    "run_managed_browser.py",
)


def _sha_or_none(value):
    return value is None or isinstance(value, str) and SHA.fullmatch(value) is not None


def _timestamp_ns(value):
    from docker_volume_development_interrupted import _docker_timestamp_ns

    try:
        return _docker_timestamp_ns(value)
    except (ValueError, TypeError, OverflowError) as error:
        raise BuildControlError("Docker service timestamp is invalid") from error


def validate_admitted_parent(
    original,
    development_terminal,
    prior_resume,
    document,
    source_root,
    project,
    control_volume,
    attempt,
    base_attempt,
    config_sha256,
):
    """Bind the refused resume to the exact successful DEV parent/configuration.

    ``prior_resume`` is treated only as an opaque prior pointer. It is pinned by
    its byte digest elsewhere and is not used as authority for current service
    incarnations. The exact refused-resume receipt owns those pre-start pins.
    """
    require(isinstance(original, dict)
        and original.get("schema") == "fullmag.docker-build-operation.v1"
        and original.get("phase") == "resume"
        and original.get("state") == "outcome-unknown-resources-retained"
        and original.get("attempt") == attempt
        and original.get("compose_project") == project
        and original.get("control_volume") == control_volume
        and original.get("helper_container") == "fullmag-control-" + attempt,
        "Original retained resume identity differs")
    inputs = original.get("inputs")
    require(isinstance(inputs, dict)
        and inputs.get("attempt") == base_attempt
        and inputs.get("source_root") == str(source_root)
        and inputs.get("config_sha256") == config_sha256,
        "Resume does not name the exact successful base/configuration")
    require(isinstance(development_terminal, dict)
        and development_terminal.get("schema") == "fullmag.docker-build-operation.v1"
        and development_terminal.get("phase") == "development"
        and development_terminal.get("state") == "succeeded"
        and development_terminal.get("attempt") == base_attempt
        and development_terminal.get("compose_project") == project
        and development_terminal.get("control_volume") == control_volume
        and development_terminal.get("config_sha256") in (None, config_sha256),
        "Base development attempt is not the exact succeeded parent")
    dev_inputs = development_terminal.get("inputs")
    require(isinstance(dev_inputs, dict)
        and dev_inputs.get("source_root") == str(source_root)
        and dev_inputs.get("image_id") == inputs.get("image_id"),
        "Successful parent source/image differs from the refused resume")
    if prior_resume is not None:
        require(isinstance(prior_resume, dict)
            and prior_resume.get("schema") == "fullmag.docker-build-operation.v1"
            and prior_resume.get("phase") == "resume"
            and prior_resume.get("attempt") != attempt
            and isinstance(prior_resume.get("attempt"), str)
            and TOKEN.fullmatch(prior_resume["attempt"]),
            "Prior resume pointer is not a recognized immutable resume record")

    require(isinstance(document, dict)
        and document.get("name") == project
        and set(document.get("services", {})) == {"backend", "frontend"}
        and digest(canonical(document)) == config_sha256
        and document["services"]["backend"].get("environment", {}).get(
            "FULLMAG_SESSION_STORAGE_PROFILE") == "linux-native-v1"
        and document["services"]["backend"].get("environment", {}).get(
            "FULLMAG_STARTUP_ENABLED") != "1"
        and all(isinstance(document["services"][name].get("image"), str)
            and document["services"][name].get("image") for name in ("backend", "frontend")),
        "Retained Compose identity or startup contract differs")
    require(original.get("state_root") == development_terminal.get("state_root")
        and original.get("backend_volumes") == development_terminal.get("backend_volumes")
        and original.get("frontend_volume") == development_terminal.get("frontend_volume"),
        "Resume changed the retained state root or volume identities")
    for name in ("backend", "frontend"):
        require(isinstance(original.get(name + "_container"), str)
            and SHA.fullmatch(original[name + "_container"])
            and isinstance(original.get(name + "_started_at"), str)
            and original[name + "_started_at"],
            "Resume pre-start service pin is missing: " + name)
    require(document["services"]["backend"].get("image") == inputs.get("image_id")
        and document["services"]["backend"].get("image") == dev_inputs.get("image_id"),
        "Backend image differs from the successful parent")
    return development_terminal


def _matches_compose_error(receipt_error, state_error, container_name):
    if receipt_error == state_error:
        return True
    if (not isinstance(receipt_error, str) or not isinstance(state_error, str)
            or "\n" in state_error or "\r" in state_error):
        return False
    name = container_name.lstrip("/") if isinstance(container_name, str) else ""
    if not name or "/" in name or "\n" in name or "\r" in name:
        return False
    expected = [
        "Container " + name + " Starting",
        "Container " + name + " Error response from daemon: " + state_error,
        "Error response from daemon: " + state_error,
    ]
    return [line.strip() for line in receipt_error.splitlines()] == expected


def _stable_state_fingerprint(state):
    fields = (
        "Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead",
        "Pid", "ExitCode", "Error", "StartedAt", "FinishedAt",
    )
    require(isinstance(state, dict) and all(key in state for key in fields),
        "Docker service state lacks stable lifecycle fields")
    return digest(canonical({key: state[key] for key in fields}))


def validate_admitted_services(original, actual, *, compose_backend_name):
    """Require the failed backend start and unchanged pre-start incarnations."""
    require(isinstance(actual, dict) and set(actual) == {"backend", "frontend"},
        "Exact backend/frontend observations are required")
    started_at = original.get("started_at")
    require(isinstance(started_at, (int, float)) and not isinstance(started_at, bool),
        "Resume start time is missing")
    for name in ("backend", "frontend"):
        service = actual[name]
        state = service.get("State", {})
        require(service.get("Id") == original.get(name + "_container")
            and state.get("StartedAt") == original.get(name + "_started_at"),
            "Service ID/StartedAt differs from its pre-start pin: " + name)
        require(all(state.get(key) is False for key in ("OOMKilled", "Dead", "Restarting", "Paused")),
            "Service is in an unsafe Docker state: " + name)
    backend = actual["backend"].get("State", {})
    require(backend.get("Status") == "exited" and backend.get("Running") is False
        and backend.get("Pid") == 0 and backend.get("ExitCode") == 127
        and _timestamp_ns(backend.get("FinishedAt")) < int(started_at * 1_000_000_000),
        "Backend was not absent after a pre-PID1 OCI refusal")
    prehandoff_refusal.validate_mount_error(original.get("error"))
    prehandoff_refusal.validate_mount_error(backend.get("Error"))
    require(_matches_compose_error(original.get("error"), backend.get("Error"), compose_backend_name),
        "Backend's exact OCI mount error differs from the retained resume receipt")
    frontend = actual["frontend"].get("State", {})
    require(frontend.get("Error") in (None, ""), "Frontend has an unrelated Docker error")
    if frontend.get("Running") is True:
        require(frontend.get("Status") == "running" and type(frontend.get("Pid")) is int
            and frontend["Pid"] > 0,
            "Running frontend state is not a stable pre-start incarnation")
    else:
        require(frontend.get("Running") is False and frontend.get("Status") == "exited"
            and frontend.get("Pid") == 0
            and _timestamp_ns(frontend.get("FinishedAt")) < int(started_at * 1_000_000_000),
            "Stopped frontend changed during the refused resume")


def _commit_protocol_request(request):
    """Adapt only the CAS writer's closed phase selector, never the stored schema."""
    result = copy.deepcopy(request)
    result["schema"] = MOUNT_REFUSAL_SCHEMA
    return result


def observer_script(control, request, current_receipt_sha256):
    root = "resume/attempts/" + request["attempt"]
    return shared_claim_script(
        control,
        root,
        _commit_protocol_request(request),
        current_receipt_sha256,
        phase="resume",
        publish_verified=False,
    )


def failure_terminal(original, request, *, request_path, request_sha256,
                     observer_record, finished_at):
    result = copy.deepcopy(original)
    result.pop("finished_at", None)
    result.update(
        state="failed-confirmed",
        finished_at=finished_at,
        backend_container=request["containers"]["backend"]["id"],
        frontend_container=request["containers"]["frontend"]["id"],
        admitted_resume_mount_refusal_proof=request["failure"],
        reconciliation={
            "schema": RECONCILIATION_SCHEMA,
            "request": request_path,
            "request_sha256": request_sha256,
            "unknown_receipt_sha256": request["unknown_receipt_sha256"],
            "controller_sha256": request["controller_sha256"],
            "observer_container": observer_record["container_name"],
            "observer": observer_record,
            "evidence": request["failure"],
        },
    )
    return result


def _validate_shape(request):
    require(isinstance(request, dict) and set(request) == {
        "schema", "attempt", "base_attempt", "source_root", "source_revision",
        "compose_project", "port", "config_sha256", "unknown_receipt_sha256",
        "controller_sha256", "containers", "failure",
    }, "Admitted resume refusal request keys differ")
    require(request["schema"] == SCHEMA
        and isinstance(request["attempt"], str) and TOKEN.fullmatch(request["attempt"])
        and isinstance(request["base_attempt"], str) and TOKEN.fullmatch(request["base_attempt"])
        and request["attempt"] != request["base_attempt"],
        "Admitted resume/base attempt identity differs")
    require(isinstance(request["source_root"], str) and Path(request["source_root"]).is_absolute()
        and isinstance(request["source_revision"], str)
        and re.fullmatch(r"[0-9a-f]{40}", request["source_revision"]),
        "Source path/revision is invalid")
    require(isinstance(request["compose_project"], str) and request["compose_project"]
        and type(request["port"]) is int and 1024 <= request["port"] <= 65535,
        "Compose project or frontend port is invalid")
    for key in ("config_sha256", "unknown_receipt_sha256", "controller_sha256"):
        require(isinstance(request[key], str) and SHA.fullmatch(request[key]),
            "Invalid request digest: " + key)
    containers = request["containers"]
    require(isinstance(containers, dict) and set(containers) == {"lease", "backend", "frontend"},
        "Exact original helper and both service pins are required")
    for pin in containers.values():
        require(isinstance(pin, dict) and set(pin) == {"id", "image", "started_at", "fingerprint"}
            and isinstance(pin["id"], str) and SHA.fullmatch(pin["id"])
            and isinstance(pin["image"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", pin["image"])
            and isinstance(pin["started_at"], str) and pin["started_at"]
            and isinstance(pin["fingerprint"], str) and SHA.fullmatch(pin["fingerprint"]),
            "Container pin is incomplete")
    require(len({pin["id"] for pin in containers.values()}) == 3,
        "Resume helper/backend/frontend IDs must be distinct")
    proof = request["failure"]
    require(isinstance(proof, dict) and set(proof) == {
        "error", "error_sha256", "parent", "certificate", "private_owner_sha256",
        "frontend_inputs_sha256", "frontend_seed_sha256", "helper_log_sha256",
        "service_states", "engine_id", "active_sha256", "current_sha256",
        "verified_sha256", "state_files", "preserved_control_files",
        "base_documents", "controllers",
    }, "Admitted resume failure proof keys differ")
    prehandoff_refusal.validate_mount_error(proof["error"])
    require(SHA.fullmatch(proof["error_sha256"]) and digest(proof["error"].encode()) == proof["error_sha256"],
        "Exact OCI error digest differs")
    parent = proof["parent"]
    require(isinstance(parent, dict) and set(parent) == {
        "attempt", "terminal_sha256", "compose_sha256", "config_sha256", "source_root",
        "compose_project", "control_volume", "image_id", "state_root",
        "backend_container", "frontend_container", "backend_started_at",
        "frontend_started_at", "previous_resume_sha256", "previous_resume_attempt",
    }, "Successful parent identity keys differ")
    require(parent["attempt"] == request["base_attempt"]
        and parent["source_root"] == request["source_root"]
        and parent["compose_project"] == request["compose_project"]
        and parent["config_sha256"] == request["config_sha256"]
        and isinstance(parent["control_volume"], str) and parent["control_volume"]
        and isinstance(parent["image_id"], str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", parent["image_id"])
        and isinstance(parent["state_root"], str) and Path(parent["state_root"]).is_absolute()
        and isinstance(parent["backend_container"], str) and SHA.fullmatch(parent["backend_container"])
        and isinstance(parent["frontend_container"], str) and SHA.fullmatch(parent["frontend_container"])
        and isinstance(parent["backend_started_at"], str) and parent["backend_started_at"]
        and isinstance(parent["frontend_started_at"], str) and parent["frontend_started_at"],
        "Successful parent pins differ from request identity")
    for key in ("terminal_sha256", "compose_sha256", "config_sha256"):
        require(isinstance(parent[key], str) and SHA.fullmatch(parent[key]), "Invalid parent digest: " + key)
    require(_sha_or_none(parent["previous_resume_sha256"])
        and (parent["previous_resume_attempt"] is None
            or isinstance(parent["previous_resume_attempt"], str)
            and TOKEN.fullmatch(parent["previous_resume_attempt"])
            and parent["previous_resume_attempt"] != request["attempt"]),
        "Prior successful resume pin is invalid")
    certificate = proof["certificate"]
    require(isinstance(certificate, dict) and set(certificate) == {"path", "sha256", "inode", "device"}
        and isinstance(certificate["path"], str) and Path(certificate["path"]).is_absolute()
        and isinstance(certificate["sha256"], str) and SHA.fullmatch(certificate["sha256"])
        and type(certificate["inode"]) is int and certificate["inode"] > 0
        and type(certificate["device"]) is int and certificate["device"] > 0,
        "Retained native host certificate pin is invalid")
    for key in ("private_owner_sha256", "frontend_inputs_sha256", "frontend_seed_sha256",
                "helper_log_sha256", "active_sha256"):
        require(_sha_or_none(proof[key]) and (key == "frontend_seed_sha256" or proof[key] is not None),
            "Invalid failure digest: " + key)
    require(_sha_or_none(proof["current_sha256"]) and _sha_or_none(proof["verified_sha256"]),
        "Previous resume current/verified pointer pin is invalid")
    require(isinstance(proof["service_states"], dict)
        and set(proof["service_states"]) == {"backend", "frontend"}
        and all(isinstance(value, str) and SHA.fullmatch(value)
            for value in proof["service_states"].values()),
        "Service state pins are incomplete")
    expected_state_files = set(prehandoff_refusal.STATE_FILES)
    require(isinstance(proof["state_files"], dict)
        and set(proof["state_files"]) == expected_state_files
        and all(isinstance(value, str) and SHA.fullmatch(value)
            for value in proof["state_files"].values()),
        "Native host identity file pins are incomplete")
    require(isinstance(proof["preserved_control_files"], dict)
        and set(proof["preserved_control_files"]) == set(PRESERVED_CONTROL_FILES)
        and all(_sha_or_none(value) for value in proof["preserved_control_files"].values()),
        "Historical runtime-control files are not fully pinned")
    require(isinstance(proof["base_documents"], dict)
        and set(proof["base_documents"]) == set(BASE_DOCUMENTS)
        and all(isinstance(value, str) and SHA.fullmatch(value)
            for value in proof["base_documents"].values()),
        "Successful base attempt documents are not fully pinned")
    require(isinstance(proof["controllers"], dict)
        and set(proof["controllers"]) == set(CONTROLLERS)
        and all(isinstance(value, str) and SHA.fullmatch(value)
            for value in proof["controllers"].values())
        and proof["controllers"]["docker_volume_admitted_resume_mount_refusal.py"] == request["controller_sha256"],
        "Recovery controller source pins differ")


def _context(source_root):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_host import require_host

    require_host()
    selected, layout = _select_source(Path(source_root).resolve(strict=True), source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"][
        "FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    require(not control.namespace, "Namespaced control volumes need their dedicated recovery")
    # Recovery must never create or permission-repair a missing control volume.
    observed = json.loads(docker_capture("volume", "inspect", control.volume).stdout)
    require(isinstance(observed, list) and len(observed) == 1, "Control volume identity is ambiguous")
    volume = observed[0]
    require(volume.get("Name") == control.volume and volume.get("Driver") == "local"
        and not volume.get("Options")
        and all((volume.get("Labels") or {}).get(key) == value
            for key, value in control.shared_labels.items()),
        "Existing control volume ownership differs; no repair or replacement is permitted")
    return selected, layout, identity, control


def _identity_file_pins(state_root):
    import docker_volume_dev as dev

    root = Path(state_root)
    require(root.is_dir() and not root.is_symlink() and root.resolve(strict=True) == root,
        "Native state root is missing, linked, or noncanonical")
    host = dev._session_host()
    certificate = dev._certificate_path(root)
    paths = {
        ".fullmag-linux-native-owner.json": root / host.OWNER_NAME,
        ".linux-native-sentinel": root / ".linux-native-sentinel",
        "linux-native-host.json": certificate,
    }
    values = {}
    for relative, path in paths.items():
        info = path.lstat()
        require(path.is_file() and not path.is_symlink() and info.st_nlink == 1,
            "Native state identity file is not a private regular file: " + relative)
        raw = host.read_owned_regular(path)
        values[relative] = digest(raw)
    return values


def _control_file_pins(control, paths):
    values = {}
    for path in paths:
        raw = read_raw(control, path, optional=True)
        values[path] = digest(raw) if raw is not None else None
    return values


def _base_document_pins(control, base_attempt):
    root = "development/attempts/" + base_attempt
    return {name: digest(read_raw(control, root + "/" + name)) for name in BASE_DOCUMENTS}


def _controller_pins(source):
    return {name: digest((source / "scripts" / name).read_bytes()) for name in CONTROLLERS}


def _exact_group_services(control, original):
    from docker_volume_activation_reconcile import _validate_helper, _validate_helper_logged

    helper_name = original.get("helper_container")
    helper, helper_id = _validate_helper(control, helper_name, original.get("attempt"), phase="resume")
    _validate_helper_logged(helper_id)
    ids = docker_capture("ps", "--all", "--no-trunc", "--filter",
        "label=com.docker.compose.project=" + control.project, "--format", "{{.ID}}").stdout.decode().split()
    require(len(ids) == 3, "Only the exact resume helper and two retained service containers may exist")
    inspected = json.loads(docker_capture("inspect", *ids).stdout)
    services = {"lease": helper}
    for item in inspected:
        name = item.get("Config", {}).get("Labels", {}).get("com.docker.compose.service")
        if name in ("backend", "frontend"):
            require(name not in services, "Duplicate retained service container")
            services[name] = item
        elif name == "build-control":
            require(item.get("Id") == helper_id, "Unexpected group helper remains")
        else:
            require(False, "Unexpected group container/resource remains")
    require(set(services) == {"lease", "backend", "frontend"},
        "Both retained service containers and the original helper are required")
    require(services["backend"].get("Id") == original.get("backend_container")
        and services["frontend"].get("Id") == original.get("frontend_container"),
        "Resume service IDs differ from the original receipt")
    return services


def _validate_retained_compose(document, actual, prestart, port):
    import docker_volume_dev as dev

    ports = document["services"]["frontend"].get("ports", [])
    require(len(ports) == 1 and str(ports[0].get("published")) == str(port)
        and ports[0].get("host_ip") == "127.0.0.1", "Retained frontend port differs")
    for name in ("backend", "frontend"):
        service = document["services"][name]
        expected_name = service.get("container_name", document["name"] + "-" + name + "-1")
        observed_name = actual[name].get("Name")
        require(isinstance(observed_name, str) and observed_name.lstrip("/") == expected_name,
            "Retained Compose container name differs: " + name)
        require(actual[name].get("Image") == service.get("image"),
            "Retained service image differs from Compose: " + name)
        image = json.loads(docker_capture("image", "inspect", service["image"]).stdout)
        require(isinstance(image, list) and len(image) == 1 and isinstance(image[0].get("Config"), dict),
            "Retained service image config is ambiguous: " + name)
        dev._validate_retained_service(
            document, actual[name], name, image[0]["Config"],
            expected_started_at=prestart.get(name + "_started_at"),
        )


def _load_previous_resume(control, attempt, base_attempt):
    current_raw = read_raw(control, "resume/current.json", optional=True)
    verified_raw = read_raw(control, "resume/verified.json", optional=True)
    if current_raw is None:
        return None, None, None
    current = json.loads(current_raw)
    require(current.get("schema") == "fullmag.docker-build-operation.v1"
        and current.get("phase") == "resume"
        and current.get("attempt") != attempt
        and isinstance(current.get("attempt"), str)
        and TOKEN.fullmatch(current["attempt"]),
        "Prior resume current pointer is not a recognized immutable resume record")
    # The prior current and verified pointers are preserved as independent CAS
    # inputs. They may name an older, unrelated failed recovery; neither grants
    # authority over this attempt's parent or live service incarnations.
    if verified_raw is not None:
        verified = json.loads(verified_raw)
        require(isinstance(verified, dict)
            and verified.get("schema") == "fullmag.docker-build-operation.v1"
            and verified.get("phase") == "resume"
            and isinstance(verified.get("attempt"), str)
            and TOKEN.fullmatch(verified["attempt"]),
            "Prior verified resume pointer is not a recognized immutable resume record")
    return current, current_raw, digest(current_raw)


def _read_original(control, attempt):
    root = "resume/attempts/" + attempt
    current_raw = read_raw(control, root + "/receipt.json")
    saved_raw = read_raw(control, root + "/unknown-receipt.json", optional=True)
    original_raw = saved_raw if saved_raw is not None else current_raw
    original = json.loads(original_raw)
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
        and original.get("phase") == "resume"
        and original.get("state") == "outcome-unknown-resources-retained"
        and original.get("attempt") == attempt,
        "Exact unknown resume receipt is not available")
    require(read_raw(control, root + "/terminal.json", optional=True) is None,
        "Resume already has a terminal; use its exact existing recovery receipt")
    return root, current_raw, saved_raw, original_raw, original


def _build_request(control, selected, layout, identity, *, attempt, base_attempt, config_sha256, port):
    import docker_group_storage
    import docker_volume_dev as dev
    import fullmag_storage as storage

    require(TOKEN.fullmatch(attempt) is not None and TOKEN.fullmatch(base_attempt) is not None
        and attempt != base_attempt, "Exact distinct resume/base attempts are required")
    root, receipt_raw, unknown_raw, original_raw, original = _read_original(control, attempt)
    require(digest(original_raw) == digest(receipt_raw) or unknown_raw is not None,
        "Current receipt changed before the original unknown receipt was retained")
    require(read_raw(control, "active") == (attempt + "\n").encode(),
        "The exact retained resume attempt does not own /control/active")
    base_root = "development/attempts/" + base_attempt
    terminal_raw = read_raw(control, base_root + "/terminal.json")
    terminal = json.loads(terminal_raw)
    compose_raw = read_raw(control, base_root + "/compose.json")
    document = json.loads(compose_raw)
    config_digest = digest(canonical(document))
    require(config_digest == config_sha256 and original.get("inputs", {}).get("config_sha256") == config_digest,
        "Exact saved Compose config digest differs")
    require(read_raw(control, "development/current.json") == terminal_raw
        and read_raw(control, "development/verified.json") == terminal_raw,
        "Successful base is not the current verified development attempt")
    prior_resume, prior_resume_raw, prior_resume_sha = _load_previous_resume(control, attempt, base_attempt)
    baseline = validate_admitted_parent(original, terminal, prior_resume, document,
        selected, control.project, control.volume, attempt, base_attempt, config_digest)
    dev._operator_probe_record_from_retained(original, document)
    state = storage.validate_path(Path(original.get("state_root", "")), layout["runtime_root"],
        "admitted resume retained state")
    actual = _exact_group_services(control, original)
    validate_admitted_services(original, {name: actual[name] for name in ("backend", "frontend")},
        compose_backend_name=actual["backend"].get("Name"))
    _validate_retained_compose(document, actual, original, port)
    require(actual["lease"].get("Id") and actual["lease"].get("State", {}).get("Running") is True,
        "Original resume helper is no longer live")
    from docker_volume_activation_reconcile import _validate_helper_logged, _validate_helper
    helper, helper_id = _validate_helper(control, original["helper_container"], attempt, phase="resume")
    require(helper_id == actual["lease"]["Id"], "Original helper lease differs")
    helper_log = _validate_helper_logged(helper_id)
    prehandoff_refusal.validate_operation_lock(control, attempt)

    host = dev._session_host()
    certificate_path = dev._certificate_path(state)
    certificate_raw = host.read_owned_regular(certificate_path)
    certificate_stat = certificate_path.lstat()
    certificate = {"path": str(certificate_path.resolve(strict=True)),
        "sha256": digest(certificate_raw), "inode": certificate_stat.st_ino,
        "device": certificate_stat.st_dev}
    state_files = _identity_file_pins(state)
    current_sha = digest(prior_resume_raw) if prior_resume_raw is not None else None
    verified_raw = read_raw(control, "resume/verified.json", optional=True)
    verified_sha = digest(verified_raw) if verified_raw is not None else None
    private_owner_raw = read_raw(control, "private/.owner.json")
    require(json.loads(private_owner_raw) == docker_group_storage.owner_manifest(control, selected),
        "Private group storage owner is not authenticated")
    inputs_raw = read_raw(control, "frontend/development-inputs.json")
    seed_raw = read_raw(control, root + "/frontend-seed.json", optional=True)
    if seed_raw is not None:
        prehandoff_refusal.validate_frontend_seed(seed_raw, inputs_raw, {
            "source_root": str(selected), "port": port,
        })
    else:
        frontend_state = actual["frontend"].get("State", {})
        require(frontend_state.get("StartedAt") == original.get("frontend_started_at"),
            "Resume is missing its frontend seed and frontend is not the unchanged pre-start incarnation")
    service_states = {name: _stable_state_fingerprint(actual[name]["State"])
        for name in ("backend", "frontend")}
    base_documents = _base_document_pins(control, base_attempt)
    preserved_control = _control_file_pins(control, PRESERVED_CONTROL_FILES)
    error = original.get("error")
    prehandoff_refusal.validate_mount_error(error)
    parent = {
        "attempt": base_attempt,
        "terminal_sha256": digest(terminal_raw),
        "compose_sha256": digest(compose_raw),
        "config_sha256": config_digest,
        "source_root": str(selected),
        "compose_project": control.project,
        "control_volume": control.volume,
        "image_id": original.get("inputs", {}).get("image_id"),
        "state_root": str(state),
        "backend_container": terminal.get("backend_container"),
        "frontend_container": terminal.get("frontend_container"),
        "backend_started_at": baseline.get("backend_started_at"),
        "frontend_started_at": baseline.get("frontend_started_at"),
        "previous_resume_sha256": prior_resume_sha,
        "previous_resume_attempt": prior_resume.get("attempt") if prior_resume is not None else None,
    }
    proof = {
        "error": error,
        "error_sha256": digest(error.encode("utf-8")),
        "parent": parent,
        "certificate": certificate,
        "private_owner_sha256": digest(private_owner_raw),
        "frontend_inputs_sha256": digest(inputs_raw),
        "frontend_seed_sha256": digest(seed_raw) if seed_raw is not None else None,
        "helper_log_sha256": digest(helper_log.encode()),
        "service_states": service_states,
        "engine_id": docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip(),
        "active_sha256": digest(read_raw(control, "active")),
        "current_sha256": current_sha,
        "verified_sha256": verified_sha,
        "state_files": state_files,
        "preserved_control_files": preserved_control,
        "base_documents": base_documents,
        "controllers": _controller_pins(selected),
    }
    request = {
        "schema": SCHEMA,
        "attempt": attempt,
        "base_attempt": base_attempt,
        "source_root": str(selected),
        "source_revision": subprocess.run(["git", "-C", str(selected), "rev-parse", "HEAD"],
            check=True, capture_output=True).stdout.decode().strip(),
        "compose_project": control.project,
        "port": port,
        "config_sha256": config_digest,
        "unknown_receipt_sha256": digest(original_raw),
        "controller_sha256": proof["controllers"]["docker_volume_admitted_resume_mount_refusal.py"],
        "containers": {name: {
            "id": actual[name]["Id"],
            "image": actual[name]["Image"],
            "started_at": actual[name]["State"]["StartedAt"],
            "fingerprint": fingerprint(actual[name]),
        } for name in ("lease", "backend", "frontend")},
        "failure": proof,
    }
    _validate_shape(request)
    prehandoff_refusal._validate_host_certificate(request, document, state)
    return request, original_raw, original, actual, document, state


def _validate_failure(control, selected, layout, identity, request):
    require(request["source_root"] == str(selected)
        and request["compose_project"] == control.project,
        "Recovery request belongs to another checkout/group")
    revision = subprocess.run(["git", "-C", str(selected), "rev-parse", "HEAD"],
        check=True, capture_output=True).stdout.decode().strip()
    require(revision == request["source_revision"], "Selected source revision changed")
    observed, original_raw, original, actual, document, state = _build_request(
        control, selected, layout, identity,
        attempt=request["attempt"], base_attempt=request["base_attempt"],
        config_sha256=request["config_sha256"], port=request["port"],
    )
    require(observed == request and digest(original_raw) == request["unknown_receipt_sha256"],
        "Resume receipt, service state, Compose binds, native owner, or preserved artifacts changed")
    for name, expected in request["containers"].items():
        from docker_volume_reconcile import validate_incarnation
        validate_incarnation(actual[name], expected, control.project, running=(
            actual[name].get("State", {}).get("Running") is True))
    return original_raw, original, actual, document, state


def _request_path(attempt, request_sha256):
    require(TOKEN.fullmatch(attempt) is not None and SHA.fullmatch(request_sha256) is not None,
        "Invalid admitted resume request identity")
    return "verification/admitted-resume-mount-refusal/" + attempt + "/" + request_sha256 + "/request.json"


def prepare_request(args):
    selected, layout, identity, control = _context(args.source_root)
    require(args.config_sha256 is not None and SHA.fullmatch(args.config_sha256),
        "Exact saved Compose SHA-256 is required")
    request, _, _, _, _, _ = _build_request(
        control, selected, layout, identity,
        attempt=args.attempt, base_attempt=args.base_attempt,
        config_sha256=args.config_sha256, port=args.port,
    )
    raw = canonical(request) + b"\n"
    request_sha = digest(raw)
    path = _request_path(request["attempt"], request_sha)
    write_immutable(control, path, raw)
    return {"state": "request-pinned", "request": path, "request_sha256": request_sha,
        "attempt": request["attempt"], "base_attempt": request["base_attempt"],
        "services_started": False, "native_state_changed": False}


def _verify_finalization(control, root, request, result_raw):
    for path in (root + "/receipt.json", root + "/terminal.json", "resume/current.json"):
        require(read_raw(control, path) == result_raw,
            "Admitted resume failure terminal publication differs: " + path)
    verified = read_raw(control, "resume/verified.json", optional=True)
    require((digest(verified) if verified is not None else None) == request["failure"]["verified_sha256"],
        "Failure-only publication changed the previous verified resume")


def _load_partial_result(control, root, request, request_sha, unknown_raw):
    receipt_raw = read_raw(control, root + "/receipt.json")
    if digest(receipt_raw) == digest(unknown_raw):
        return None
    result = json.loads(receipt_raw)
    reconciliation = result.get("reconciliation", {})
    require(result.get("schema") == "fullmag.docker-build-operation.v1"
        and result.get("phase") == "resume" and result.get("attempt") == request["attempt"]
        and result.get("state") == "failed-confirmed"
        and result.get("admitted_resume_mount_refusal_proof") == request["failure"]
        and reconciliation.get("request_sha256") == request_sha
        and reconciliation.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"],
        "Changed resume receipt has no exact admitted refusal publication")
    journal = root + "/reconciliation/" + digest(receipt_raw)
    prepared = json.loads(read_raw(control, journal + "/prepared.json"))
    require(read_raw(control, journal + "/result.json") == receipt_raw
        and prepared.get("request_sha256") == request_sha
        and prepared.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"]
        and prepared.get("result_sha256") == digest(receipt_raw),
        "Partial admitted refusal has no exact immutable journal")
    current = read_raw(control, "resume/current.json", optional=True)
    proof_current = request["failure"]["current_sha256"]
    require((digest(current) if current is not None else None) in (proof_current, digest(receipt_raw)),
        "Resume current pointer changed outside the exact partial result")
    return receipt_raw


def _completed(control, root, request, request_sha):
    raw = read_raw(control, root + "/terminal.json", optional=True)
    if raw is None:
        return False
    result = json.loads(raw)
    reconciliation = result.get("reconciliation", {})
    require(result.get("schema") == "fullmag.docker-build-operation.v1"
        and result.get("phase") == "resume" and result.get("attempt") == request["attempt"]
        and result.get("compose_project") == control.project
        and result.get("control_volume") == control.volume
        and result.get("state") == "failed-confirmed"
        and result.get("admitted_resume_mount_refusal_proof") == request["failure"]
        and reconciliation.get("request_sha256") == request_sha
        and reconciliation.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"],
        "Completed admitted refusal terminal identity differs")
    unknown = read_raw(control, root + "/unknown-receipt.json")
    require(digest(unknown) == request["unknown_receipt_sha256"],
        "Completed admitted refusal original receipt differs")
    journal = root + "/reconciliation/" + digest(raw)
    prepared = json.loads(read_raw(control, journal + "/prepared.json"))
    require(read_raw(control, journal + "/result.json") == raw
        and prepared.get("request_sha256") == request_sha
        and prepared.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"]
        and prepared.get("result_sha256") == digest(raw),
        "Completed admitted refusal journal differs")
    _verify_finalization(control, root, request, raw)
    prehandoff_refusal.wait_release(control, request)
    return True


def _validate_observer(control, claim, claim_name, helper_image_id, request, request_sha):
    from docker_dev_host import docker_argv

    rows = json.loads(docker_capture("inspect", claim_name).stdout)
    require(isinstance(rows, list) and len(rows) == 1, "Resume observer helper is ambiguous")
    actual = rows[0]
    validate_original_owner(actual, {"helper_container": claim_name}, control, helper_image_id)
    require(actual.get("State", {}).get("Running") is True
        and actual.get("State", {}).get("StartedAt"), "Resume observer helper is not live")
    observer_record = {
        "container_name": claim_name,
        "container_id": actual["Id"],
        "image_id": actual["Image"],
        "started_at": actual["State"]["StartedAt"],
        "fingerprint": fingerprint(actual),
        "request_sha256": request_sha,
        "phase": "BEGIN-requested",
        "outcome": "pending-observation",
    }
    return observer_record


def _apply(control, selected, layout, identity, request, request_path, request_sha):
    from docker_volume_activation_reconcile import _probe_helper_absence

    root = "resume/attempts/" + request["attempt"]
    if _completed(control, root, request, request_sha):
        return {"state": "failed-confirmed", "attempt": request["attempt"],
            "already_completed": True, "services_started": False}
    original_raw, original, actual, document, state = _validate_failure(
        control, selected, layout, identity, request)
    current_receipt_raw = read_raw(control, root + "/receipt.json")
    unknown_raw = read_raw(control, root + "/unknown-receipt.json", optional=True)
    if unknown_raw is None:
        require(digest(current_receipt_raw) == request["unknown_receipt_sha256"],
            "Original unknown receipt changed before apply")
        unknown_raw = current_receipt_raw
    else:
        require(digest(unknown_raw) == request["unknown_receipt_sha256"],
            "Saved unknown receipt differs before apply")
    result_raw = _load_partial_result(control, root, request, request_sha, unknown_raw)
    current_receipt_sha = digest(current_receipt_raw)
    helper_name = "fullmag-admitted-resume-reconcile-" + request["attempt"]
    require(_probe_helper_absence(helper_name) is not None,
        "An observer with the exact recovery name already exists; inspect its receipt first")
    protocol_request = _commit_protocol_request(request)
    script = shared_claim_script(control, root, protocol_request, current_receipt_sha,
        phase="resume", publish_verified=False)
    claim = subprocess.Popen(control.helper_args(script, name=helper_name), stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    begin_requested = False
    observer_record = None
    try:
        require(control._line(claim) == "READY", "Resume observer did not acquire its lease")
        helper_image = json.loads(docker_capture("image", "inspect", control.image).stdout)
        require(isinstance(helper_image, list) and len(helper_image) == 1,
            "Pinned observer image is ambiguous")
        observer_record = _validate_observer(control, claim, helper_name,
            helper_image[0]["Id"], request, request_sha)
        # Re-check all target facts after the observer has acquired its lock.
        original_raw, original, actual, document, state = _validate_failure(
            control, selected, layout, identity, request)
        if read_raw(control, root + "/unknown-receipt.json", optional=True) is None:
            write_immutable(control, root + "/unknown-receipt.json", original_raw)
        control.write("resume/attempts/" + request["attempt"]
            + "/reconciliation/observers/" + observer_record["container_id"] + ".json",
            observer_record)
        begin_requested = True
        claim.stdin.write(b"BEGIN\n")
        claim.stdin.flush()
        require(control._line(claim) == "OBSERVING",
            "Resume observer BEGIN outcome unknown; original resources retained")
        original_raw, original, actual, document, state = _validate_failure(
            control, selected, layout, identity, request)
        if result_raw is None:
            result = failure_terminal(original, request, request_path=request_path,
                request_sha256=request_sha, observer_record=observer_record, finished_at=time.time())
            result_raw = canonical(result) + b"\n"
        transaction_root = root + "/reconciliation/" + digest(result_raw)
        write_immutable(control, transaction_root + "/result.json", result_raw)
        write_immutable(control, transaction_root + "/prepared.json", canonical({
            "schema": SCHEMA,
            "request_sha256": request_sha,
            "unknown_receipt_sha256": request["unknown_receipt_sha256"],
            "result_sha256": digest(result_raw),
        }) + b"\n")
        require(claim.poll() is None, "Resume observer exclusion lease disappeared")
        claim.stdin.write(("COMMIT " + digest(result_raw) + "\n").encode("ascii"))
        claim.stdin.flush()
        claim.stdin.close()
        require(control._line(claim) == "COMMITTED",
            "Resume terminal publication outcome unknown; retain original lease")
        require(claim.wait(timeout=30) == 0, "Resume observer helper did not exit cleanly")
        require(read_raw(control, root + "/terminal.json") == result_raw,
            "Resume failure terminal differs from prepared result")
        _verify_finalization(control, root, request, result_raw)
        prehandoff_refusal.wait_release(control, request)
        return {"state": "failed-confirmed", "attempt": request["attempt"],
            "services_started": False, "native_state_changed": False,
            "terminal_sha256": digest(result_raw)}
    except BaseException as error:
        if observer_record is not None:
            control.write("resume/attempts/" + request["attempt"]
                + "/reconciliation/last-observation-error.json", {
                    "schema": SCHEMA,
                    "request_sha256": request_sha,
                    "error": str(error),
                    "observed_at": time.time(),
                    "observer": observer_record,
                    "begin_may_have_started": begin_requested,
                    "state": "observer-outcome-unknown-retained" if begin_requested else "failed-before-BEGIN",
                    "requires_dedicated_observer_recovery": begin_requested,
                })
        raise
    finally:
        if claim.stdin and not claim.stdin.closed:
            claim.stdin.close()


def reconcile_request(args):
    selected, layout, identity, control = _context(args.source_root)
    request_raw = read_raw(control, args.request)
    require(SHA.fullmatch(args.request_sha256) and digest(request_raw) == args.request_sha256,
        "Admitted resume request CAS differs")
    request = json.loads(request_raw)
    _validate_shape(request)
    require(request["source_root"] == str(selected)
        and request["compose_project"] == control.project
        and request["port"] == args.port,
        "Selected checkout/group/port differs from the pinned request")
    require(digest(Path(__file__).read_bytes()) == request["controller_sha256"],
        "Admitted resume recovery controller changed")
    for name, expected in request["failure"]["controllers"].items():
        require(digest((selected / "scripts" / name).read_bytes()) == expected,
            "Pinned recovery controller changed: " + name)
    root = "resume/attempts/" + request["attempt"]
    if _completed(control, root, request, args.request_sha256):
        return {"state": "failed-confirmed", "attempt": request["attempt"],
            "already_completed": True, "services_started": False}
    _validate_failure(control, selected, layout, identity, request)
    if args.preview:
        return {"state": "validated-only", "request_sha256": args.request_sha256,
            "attempt": request["attempt"], "base_attempt": request["base_attempt"],
            "native_state_changed": False, "services_started": False}
    return _apply(control, selected, layout, identity, request, args.request, args.request_sha256)


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    actions = root.add_subparsers(dest="action", required=True)
    prepare = actions.add_parser("prepare", help="pin exact admitted resume OCI refusal evidence")
    prepare.add_argument("--source-root", required=True, type=Path)
    prepare.add_argument("--attempt", required=True)
    prepare.add_argument("--base-attempt", required=True)
    prepare.add_argument("--config-sha256", required=True)
    prepare.add_argument("--port", required=True, type=int)
    inspect = actions.add_parser("reconcile", help="preview or commit one exact failure-only terminal")
    inspect.add_argument("--source-root", required=True, type=Path)
    inspect.add_argument("--request", required=True)
    inspect.add_argument("--request-sha256", required=True)
    inspect.add_argument("--port", required=True, type=int)
    mode = inspect.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true")
    mode.add_argument("--apply", action="store_true")
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    result = prepare_request(args) if args.action == "prepare" else reconcile_request(args)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
