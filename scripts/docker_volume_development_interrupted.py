"""Confirm a pinned interrupted DEV start or resume; never start services."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import io
import re
import tarfile
import uuid
from pathlib import Path
import shlex
import subprocess
from docker_build_control import (MAX_LOG_BYTES, BuildControl, BuildControlError, bounded_capture,
                                  canonical, docker_capture, toolchain_configuration)
from docker_volume_reconcile import SHA, TOKEN, digest, fingerprint, read_raw, require, write_immutable
from docker_volume_activation_reconcile import _probe_helper_absence
from docker_volume_toolchain_reconcile import host_clients
from docker_dev_host import docker_argv

SCHEMA = "fullmag.docker-development-interrupted.v1"
RESUME_SCHEMA = "fullmag.docker-resume-interrupted.v1"
GATE_FAILURE_SCHEMA = "fullmag.docker-development-gate-failed.v1"
GATE_FAILURE_MESSAGE = "Linux native host admission did not become ready"
GATE_RUNTIME_ABSENT_PATHS = (
    "runtime-control/runtime-services/OWNER.json",
    "runtime-control/runtime-services/LAUNCH.json",
    "runtime-control/runtime-services/OWNER.lock",
    "runtime-control/runtime-service/process-tree.json",
    "runtime-control/runtime-service/docker-all.json",
)
CONTROLLERS = ("docker_build_control.py", "docker_volume_dev.py", "docker_volume_reconcile.py",
               "docker_volume_activation_reconcile.py", "docker_volume_toolchain_reconcile.py",
               "docker_volume_prestart_recovery.py")


def _phase(r):
    return "resume" if r["schema"] == RESUME_SCHEMA else "development"


def _compose_relative(r):
    attempt = r["base_attempt"] if r["schema"] == RESUME_SCHEMA else r["attempt"]
    return "development/attempts/" + attempt + "/compose.json"


def _compose_mount(document, service, target):
    services = document.get("services") if isinstance(document, dict) else None
    definition = services.get(service) if isinstance(services, dict) else None
    mounts = definition.get("volumes") if isinstance(definition, dict) else None
    matches = [mount for mount in mounts or ()
               if isinstance(mount, dict) and mount.get("target") == target]
    require(len(matches) == 1, "Retained Compose mount is missing or ambiguous: " + service + target)
    return matches[0]


def _compose_state_root(document):
    mount = _compose_mount(document, "backend", "/state")
    source = mount.get("source")
    require(mount.get("type") == "bind" and isinstance(source, str)
            and Path(source).is_absolute() and "\x00" not in source,
            "Initial Linux state bind is not an absolute host directory")
    return Path(source)


def _compose_volume_name(document, service, target):
    mount = _compose_mount(document, service, target)
    volumes = document.get("volumes")
    source = mount.get("source")
    definition = volumes.get(source) if isinstance(volumes, dict) and isinstance(source, str) else None
    name = definition.get("name") if isinstance(definition, dict) else None
    require(mount.get("type") == "volume" and isinstance(name, str) and bool(name),
            "Retained Compose named volume is incomplete: " + service + target)
    return name


def validate_gate_container_mounts(actual, service, document, state_root):
    """Tie the stopped container's package/session mounts to retained Compose."""
    actual_mounts = actual.get("Mounts")
    require(isinstance(actual_mounts, list), "Initial-gate container has no mount inventory")
    by_target = {mount.get("Destination"): mount for mount in actual_mounts if isinstance(mount, dict)}
    require(len(by_target) == len(actual_mounts), "Initial-gate container mount inventory is ambiguous")
    if service == "backend":
        expected = {
            "/build": ("volume", _compose_volume_name(document, service, "/build"), True),
            "/opt/fullmag/package": ("volume", _compose_volume_name(document, service, "/opt/fullmag/package"), True),
            "/opt/fullmag/control": ("volume", _compose_volume_name(document, service, "/opt/fullmag/control"), True),
            "/opt/fullmag/runtime-control": ("volume", _compose_volume_name(document, service, "/opt/fullmag/runtime-control"), True),
            "/state/runs/docker-all/session-store/runtime-services": (
                "volume", _compose_volume_name(document, service,
                    "/state/runs/docker-all/session-store/runtime-services"), True),
        }
        state_compose = _compose_mount(document, service, "/state")
        expected["/state"] = ("bind", str(Path(state_compose["source"]).resolve(strict=True)), True)
    elif service == "frontend":
        expected = {
            "/state/development": ("volume", _compose_volume_name(document, service, "/state/development"), True),
            "/opt/fullmag/control": ("volume", _compose_volume_name(document, service, "/opt/fullmag/control"), False),
        }
    else:
        require(False, "Unexpected initial-gate service")
    for target, (kind, source, writable) in expected.items():
        mount = by_target.get(target)
        require(isinstance(mount, dict) and mount.get("Type") == kind and mount.get("RW") is writable,
                "Initial-gate retained mount mode differs: " + service + target)
        observed = mount.get("Source") if kind == "bind" else mount.get("Name")
        daemon_pin = document["services"][service].get("x-fullmag-daemon-binds", {}).get(target)
        pinned_wsl_alias = (kind == "bind" and isinstance(observed, str)
            and observed.startswith("/run/desktop/mnt/host/wsl/") and observed == daemon_pin)
        require(observed == source or pinned_wsl_alias,
                "Initial-gate retained mount source differs: " + service + target)
    if service == "backend":
        require(str(_compose_state_root(document).resolve(strict=True)) == str(Path(state_root).resolve(strict=True)),
                "Initial-gate state root differs from the pinned Compose bind")


def validate_gate_log(raw):
    """Accept only the bounded initial Linux admission failure, before API handoff."""
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_LOG_BYTES,
            "Pinned backend log is outside its 32 MiB bound")
    required = (
        b"backend-dev: phase=make state=complete exit_code=0",
        b"backend-dev: phase=start state=handoff",
        b"backend-dev: phase=package state=verify-complete",
        b"backend-dev: phase=gate state=start profile=linux-native-v1",
    )
    lines = raw.splitlines()
    positions = []
    for marker in required:
        matches = [index for index, line in enumerate(lines) if line.startswith(marker)]
        positions.append(matches[0] if matches else -1)
    require(all(position >= 0 for position in positions) and positions == sorted(positions),
            "Backend log does not prove completed Make/package verification and Linux gate start")
    terminal = ("backend-dev: " + GATE_FAILURE_MESSAGE).encode()
    nonempty_lines = raw.rstrip(b"\r\n").splitlines()
    require(bool(nonempty_lines) and nonempty_lines[-1] == terminal,
            "Backend log does not end at the pinned Linux admission failure")
    require(not any(line.startswith(b"backend-dev: phase=gate state=complete") for line in lines)
            and not any(line.startswith(b"backend-dev: phase=api state=exec") for line in lines),
            "Backend log proves gate completion or API execution")


def validate_gate_package_documents(receipt_raw, provenance_raw, r, backend_image):
    """Bind the retained successful package receipt to provenance and its image."""
    gate = r["gate_failure"]
    require(0 < len(receipt_raw) <= 8 * 1024 * 1024
            and 0 < len(provenance_raw) <= 8 * 1024 * 1024,
            "Stopped package document exceeds its 8 MiB bound")
    receipt_sha256, provenance_sha256 = digest(receipt_raw), digest(provenance_raw)
    require(receipt_sha256 == gate["package_receipt_sha256"]
            and provenance_sha256 == gate["provenance_sha256"],
            "Stopped package receipt/provenance CAS differs")
    try:
        receipt, provenance = json.loads(receipt_raw), json.loads(provenance_raw)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as error:
        raise BuildControlError("Stopped package receipt/provenance is not valid JSON") from error
    require(isinstance(receipt, dict) and receipt.get("schema") == "fullmag.direct-compose.backend-build-receipt.v1"
            and receipt.get("state") == "succeeded"
            and receipt.get("operation") in {"direct-compose-build", "direct-compose-cache-reuse"}
            and isinstance(receipt.get("source"), dict)
            and receipt["source"].get("resolved_commit") == gate["build_source_commit"],
            "Stopped package receipt is not the pinned successful build")
    require(isinstance(provenance, dict)
            and provenance.get("schema") == "fullmag.docker-all-image.v1"
            and provenance.get("state") == "succeeded"
            and provenance.get("image_id") == backend_image
            and provenance.get("commit") == gate["build_source_commit"]
            and provenance.get("package_root") == "/opt/fullmag/package"
            and provenance.get("backend_build_receipt") == "/opt/fullmag/package/backend-build-receipt.json"
            and provenance.get("backend_build_receipt_schema") == receipt["schema"]
            and provenance.get("build_receipt_sha256") == receipt_sha256,
            "Stopped runtime provenance does not bind the pinned image and build receipt")
    return {"receipt_sha256": receipt_sha256, "provenance_sha256": provenance_sha256}


def validate_gate_host_documents(certificate_raw, owner_raw, sentinel_raw, r, backend_image,
                                 engine_id, local_identity):
    """Validate the unchanged, pre-probe Linux storage certificate/owner/sentinel."""
    gate = r["gate_failure"]
    require(certificate_raw == owner_raw
            and digest(certificate_raw) == r["storage_certificate_sha256"]
            == gate["owner_marker_sha256"]
            and digest(sentinel_raw) == gate["sentinel_sha256"],
            "Linux host certificate, owner marker, or sentinel CAS differs")
    try:
        certificate = json.loads(certificate_raw)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as error:
        raise BuildControlError("Linux host certificate is not valid JSON") from error
    identity = gate["storage_identity"]
    token = certificate.get("owner_token") if isinstance(certificate, dict) else None
    require(isinstance(certificate, dict)
            and certificate.get("schema") == "fullmag.linux-native-host.v1"
            and certificate.get("storage_profile") == "linux-native-v1"
            and certificate.get("role") == "session"
            and certificate.get("owner_scope") == "docker-linux"
            and certificate.get("restart_verified") is False
            and isinstance(token, str) and len(token) == 32
            and all(character in "0123456789abcdef" for character in token)
            and certificate.get("image_id") == backend_image
            and certificate.get("engine_id") == engine_id
            and certificate.get("host_inode") == identity["root_inode"]
            and certificate.get("host_device") == identity["retained_device"]
            and identity["observed_device"] == identity["retained_device"]
            and isinstance(local_identity, dict)
            and all(certificate.get(key) == value for key, value in local_identity.items()),
            "Linux host certificate scope, image, storage identity, or restart state differs")
    payload = (token + ":" + backend_image).encode("ascii")
    require(sentinel_raw == payload
            and certificate.get("restart_expected_sha256") == digest(payload),
            "Linux native sentinel does not match the pending host owner")
    return certificate


def _require_empty_run_store(store):
    """Reject all session/run files while allowing the launcher's empty directories."""
    require(store.is_dir() and not store.is_symlink(), "Initial Linux session store is missing or unsafe")
    pending, visited = [store], 0
    while pending:
        parent = pending.pop()
        try:
            entries = list(parent.iterdir())
        except OSError as error:
            raise BuildControlError("Cannot inspect the initial Linux session store") from error
        visited += len(entries)
        require(visited <= 4096 and len(parent.relative_to(store).parts) <= 32,
                "Initial Linux session store exceeds its inspection bound")
        for entry in entries:
            require(not entry.is_symlink(), "Initial Linux session store contains a symlink")
            if entry.is_dir():
                pending.append(entry)
            else:
                require(False, "Initial Linux session store contains runtime/run-intent data")


def validate_gate_runtime_absence(state, runtime_records):
    """Prove there is no runtime owner, process receipt, probe, or nonempty run store."""
    require(isinstance(runtime_records, dict) and set(runtime_records) == set(GATE_RUNTIME_ABSENT_PATHS)
            and all(value is None for value in runtime_records.values()),
            "Linux runtime OWNER/LAUNCH/process/configuration records are present")
    state = Path(state)
    require(state.is_dir() and not state.is_symlink() and state.resolve(strict=True) == state,
            "Initial Linux state root is missing or noncanonical")
    for path in (state / "runs", state / "runs" / "docker-all",
                 state / "runs" / "docker-all" / "session-store"):
        require(path.is_dir() and not path.is_symlink() and path.resolve(strict=True) == path,
                "Initial Linux run-store path is missing or noncanonical")
    for name in (".linux-native-restart", ".linux-native-probe.json"):
        require(not (state / name).exists() and not (state / name).is_symlink(),
                "Linux restart/probe evidence already exists")
    require(not any(state.glob(".linux-native-probe-*")), "Linux native probe scratch already exists")
    _require_empty_run_store(state / "runs" / "docker-all")


def _stopped_package_documents(backend, r=None):
    documents = {}
    for name, path in (("receipt", "/opt/fullmag/package/backend-build-receipt.json"),
                       ("provenance", "/opt/fullmag/control/backend/runtime-provenance.json")):
        result = docker_capture("cp", backend["Id"] + ":" + path, "-")
        require(len(result.stdout) <= 8 * 1024 * 1024, "Stopped package document is unbounded")
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:*") as archive:
            members = archive.getmembers()
            require(len(members) == 1 and members[0].isfile()
                    and 0 < members[0].size <= 8 * 1024 * 1024,
                    "Stopped package document is not one bounded regular file")
            raw = archive.extractfile(members[0]).read()
        documents[name] = (raw, json.loads(raw))
    receipt_raw, receipt = documents["receipt"]
    provenance_raw, provenance = documents["provenance"]
    if r is not None and r["schema"] == GATE_FAILURE_SCHEMA:
        return validate_gate_package_documents(receipt_raw, provenance_raw, r, backend["Image"])
    require(receipt.get("state") == provenance.get("state") == "succeeded"
            and provenance.get("build_receipt_sha256") == digest(receipt_raw)
            and provenance.get("image_id") == backend["Image"],
            "Stopped package/provenance does not bind the retained image")
    return {"receipt_sha256": digest(receipt_raw), "provenance_sha256": digest(provenance_raw)}


def _interrupted_resume_certificate(state, document, r):
    """Observe a prior-boot certificate for failure publication, never admit storage."""
    import docker_volume_dev as dev
    host = dev._session_host()
    raw = host.read_owned_regular(dev._certificate_path(state))
    certificate = json.loads(raw)
    identity = r["storage_identity"]
    require(digest(raw) == r["storage_certificate_sha256"]
            and certificate.get("schema") == host.HOST_SCHEMA
            and certificate.get("storage_profile") == "linux-native-v1"
            == document["services"]["backend"]["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"]
            and certificate == json.loads(host.read_owned_regular(Path(state) / host.OWNER_NAME)),
            "Retained prior-boot certificate ownership differs")
    current = dev.local_volume(state)
    require(certificate.get("host_inode") == Path(state).stat().st_ino == identity["root_inode"]
            and certificate.get("host_device") == identity["retained_device"]
            and current.get("host_device") == identity["observed_device"]
            and certificate.get("engine_id") == r["engine_id"]
            == dev.docker_text("info", "--format", "{{.ID}}").strip()
            and all(certificate.get(key) == value for key, value in current.items() if key != "host_device"),
            "Prior-boot storage identity differs beyond its explicitly pinned device")
    # The original certificate/owner stay unchanged. Ordinary runtime admission
    # still calls _retained_certificate and must perform its separate readmission.
    return certificate


def _resume_documents(control, original, document, r, source):
    from docker_volume_frontend_frozen_recovery import validate_base, _frontend_volumes
    base = "development/attempts/" + r["base_attempt"]
    previous = json.loads(read_raw(control, base + "/terminal.json"))
    require(original.get("inputs", {}).get("attempt") == r["base_attempt"]
            and digest(canonical(document)) == original.get("inputs", {}).get("config_sha256")
            == original.get("config_sha256"), "Resume base configuration differs")
    validate_base(control, r, original, previous, document, source)
    volumes = _frontend_volumes(control, r, original, document)
    require(original.get("backend_volumes") == previous.get("backend_volumes")
            and original["backend_volumes"].get("control") == control.volume,
            "Resume backend volumes differ")
    return volumes


def validate_request(r):
    resume = isinstance(r, dict) and r.get("schema") == RESUME_SCHEMA
    gate_failure = isinstance(r, dict) and r.get("schema") == GATE_FAILURE_SCHEMA
    require(isinstance(r, dict) and set(r) == {"schema", "attempt", "source_root", "source_revision",
        "compose_project", "engine_id", "observed_at", "receipt_sha256", "compose_sha256", "active_sha256",
        "current_sha256", "verified_sha256", "helper_absence_sha256", "backend_log_sha256", "containers",
        "controller_inputs", "controller_sha256", "attempt_documents", "storage_certificate_sha256"}
        | ({"base_attempt", "host_boot_id", "failure", "storage_identity"} if resume else set())
        | ({"gate_failure"} if gate_failure else set()), "Exact interrupted-operation request required")
    require(r["schema"] in {SCHEMA, RESUME_SCHEMA, GATE_FAILURE_SCHEMA}
            and isinstance(r["attempt"], str) and TOKEN.fullmatch(r["attempt"]),
            "Invalid schema or attempt")
    for k in ("receipt_sha256", "compose_sha256", "active_sha256", "helper_absence_sha256",
              "backend_log_sha256", "controller_sha256"):
        require(isinstance(r[k], str) and SHA.fullmatch(r[k]), "Invalid digest: " + k)
    for k in ("current_sha256", "verified_sha256"):
        require(r[k] is None or isinstance(r[k], str) and SHA.fullmatch(r[k]), "Invalid pointer: " + k)
    require(isinstance(r["observed_at"], (int, float)) and not isinstance(r["observed_at"], bool)
            and 0 < r["observed_at"] < 10**11, "Pinned observation time required")
    require(isinstance(r["containers"], dict) and set(r["containers"]) == {"backend", "frontend"},
            "Both service pins required")
    for pin in r["containers"].values():
        require(isinstance(pin, dict) and set(pin) == {"id", "image", "fingerprint", "state_sha256"},
                "Exact service pin required")
        require(all(isinstance(pin[k], str) and SHA.fullmatch(pin[k]) for k in ("id", "fingerprint", "state_sha256"))
                and isinstance(pin["image"], str) and pin["image"].startswith("sha256:")
                and SHA.fullmatch(pin["image"][7:]), "Invalid service pin")
    require(r["containers"]["backend"]["id"] != r["containers"]["frontend"]["id"], "Distinct services required")
    require(isinstance(r["source_revision"], str) and len(r["source_revision"]) == 40
        and all(x in "0123456789abcdef" for x in r["source_revision"])
        and isinstance(r["engine_id"], str) and bool(r["engine_id"]), "Source/engine pins required")
    require(isinstance(r["storage_certificate_sha256"], str) and SHA.fullmatch(r["storage_certificate_sha256"]), "Storage certificate pin required")
    require(isinstance(r["attempt_documents"], dict) and set(r["attempt_documents"]) == {
        "backend-cache.json", "group-ledger.json", "frontend-seed.json", "cache-maintenance-compose.json"}
        and all(isinstance(x, str) and SHA.fullmatch(x) for x in r["attempt_documents"].values()), "Attempt documents required")
    require(isinstance(r["controller_inputs"], dict) and set(r["controller_inputs"]) == set(CONTROLLERS + (("docker_volume_development_interrupted.py", "docker_volume_frontend_frozen_recovery.py", "docker_development_inputs.py") if resume else ()))
        and all(isinstance(x, str) and SHA.fullmatch(x) for x in r["controller_inputs"].values()), "Controller pin set differs")
    if resume:
        require(isinstance(r["storage_identity"], dict) and set(r["storage_identity"]) == {
            "root_inode", "retained_device", "observed_device"}
            and all(type(value) is int and value > 0 for value in r["storage_identity"].values()),
            "Exact prior-boot storage identity required")
        require(isinstance(r["base_attempt"], str) and TOKEN.fullmatch(r["base_attempt"])
                and r["base_attempt"] != r["attempt"], "Resume base attempt differs")
        require(isinstance(r["host_boot_id"], str) and len(r["host_boot_id"]) == 36,
                "Canonical WSL boot pin required")
        try:
            boot = uuid.UUID(r["host_boot_id"])
        except ValueError as error:
            raise BuildControlError("Invalid WSL boot pin") from error
        require(boot.int != 0 and str(boot) == r["host_boot_id"], "Invalid WSL boot pin")
        require(isinstance(r["failure"], dict) and set(r["failure"]) == {
            "inputs_sha256", "previous_receipt_sha256", "receipt_sha256", "provenance_sha256"}
            and all(isinstance(value, str) and SHA.fullmatch(value) for value in r["failure"].values()),
            "Exact retained publication pins required")
    if gate_failure:
        failure = r["gate_failure"]
        require(isinstance(failure, dict) and set(failure) == {
            "backend_started_at", "backend_exit_code", "frontend_exit_code", "build_source_commit",
            "package_receipt_sha256", "provenance_sha256", "owner_marker_sha256", "sentinel_sha256",
            "storage_identity"}, "Exact initial Linux gate-failure pins required")
        require(isinstance(failure["backend_started_at"], str) and bool(failure["backend_started_at"])
                and len(failure["backend_started_at"]) <= 64
                and failure["backend_exit_code"] == 2 and type(failure["backend_exit_code"]) is int
                and failure["frontend_exit_code"] == 255 and type(failure["frontend_exit_code"]) is int,
                "Initial Linux gate-failure exit/time pins differ")
        require(isinstance(failure["build_source_commit"], str)
                and re.fullmatch(r"[0-9a-f]{40}", failure["build_source_commit"])
                and all(isinstance(failure[key], str) and SHA.fullmatch(failure[key]) for key in (
                    "package_receipt_sha256", "provenance_sha256", "owner_marker_sha256", "sentinel_sha256")),
                "Initial Linux package/owner evidence pins are invalid")
        require(failure["owner_marker_sha256"] == r["storage_certificate_sha256"],
                "Linux owner marker must pin the same bytes as its host certificate")
        identity = failure["storage_identity"]
        require(isinstance(identity, dict) and set(identity) == {
            "root_inode", "retained_device", "observed_device"}
            and all(type(value) is int and value > 0 for value in identity.values())
            and identity["retained_device"] == identity["observed_device"],
            "Exact initial Linux storage identity required")


def validate_original(original, document, r, control, source):
    if r["schema"] == RESUME_SCHEMA:
        require(original.get("schema") == "fullmag.docker-build-operation.v1"
                and original.get("phase") == "resume"
                and original.get("state") == "outcome-unknown-resources-retained"
                and original.get("attempt") == r["attempt"]
                and original.get("compose_project") == control.project == r["compose_project"]
                and original.get("control_volume") == control.volume
                and original.get("helper_container") == "fullmag-control-" + r["attempt"]
                and original.get("error") == "DEV service exited before readiness: frontend"
                and r["source_root"] == str(source), "Original retained frontend failure differs")
        require(document.get("name") == control.project and set(document.get("services", {})) == {"backend", "frontend"}
                and document["services"]["backend"].get("environment", {}).get("FULLMAG_STARTUP_ENABLED") != "1",
                "Retained resume configuration differs or enables startup Solve")
        require(all(document["services"][service]["image"] == pin["image"]
                    for service, pin in r["containers"].items()), "Retained resume images differ")
        worker = original.get("worker_cgroup", {})
        require(worker.get("state") == "ready" and worker.get("container_id") == r["containers"]["backend"]["id"]
                and worker.get("image_id") == r["containers"]["backend"]["image"]
                and worker.get("compose_project") == control.project
                and isinstance(worker.get("boot_id"), str) and worker["boot_id"] != r["host_boot_id"]
                and isinstance(original.get("backend_started_at"), str),
                "Historical worker namespace is absent or not from a previous boot")
        return
    if r["schema"] == GATE_FAILURE_SCHEMA:
        require(original.get("schema") == "fullmag.docker-build-operation.v1"
                and original.get("phase") == "development" and original.get("state") == "starting"
                and original.get("attempt") == r["attempt"] and original.get("compose_project") == control.project
                and original.get("control_volume") == control.volume
                and original.get("helper_container") == "fullmag-control-" + r["attempt"]
                and original.get("error") in (None, ""), "Original initial-gate operation differs")
        require(original.get("inputs", {}).get("source_root") == str(source)
                and r["source_root"] == str(source) and r["compose_project"] == control.project
                and original.get("inputs", {}).get("image_id") == r["containers"]["backend"]["image"],
                "Initial-gate source or runtime image differs")
        require(original.get("config_sha256") is None
                and original.get("backend_started_at") in (None, r["gate_failure"]["backend_started_at"]),
                "Initial-gate publication/readiness state differs")
        state_root = _compose_state_root(document)
        require(original.get("state_root") in (None, str(state_root)),
                "Initial Linux state root differs from its Compose bind")
        volumes = {role: _compose_volume_name(document, "backend", target) for role, target in (
            ("build", "/build"), ("package", "/opt/fullmag/package"), ("control", "/opt/fullmag/control"))}
        require(volumes["control"] == control.volume and len(set(volumes.values())) == 3,
                "Initial-gate package/cache volumes differ")
        frontend_volume = _compose_volume_name(document, "frontend", "/state/development")
        require(original.get("backend_volumes") in (None, volumes)
                and original.get("frontend_volume") in (None, frontend_volume),
                "Initial-gate receipt/Compose volume identity differs")
        require(document.get("name") == control.project
                and set(document.get("services", {})) == {"backend", "frontend"}
                and document["services"]["backend"].get("environment", {}).get(
                    "FULLMAG_SESSION_STORAGE_PROFILE") == "linux-native-v1"
                and document["services"]["backend"].get("environment", {}).get(
                    "FULLMAG_STARTUP_ENABLED") != "1",
                "Initial Linux Compose storage/startup contract differs")
        require(r["containers"]["backend"]["image"] == r["containers"]["frontend"]["image"]
                and all(document["services"][service].get("image") == pin["image"]
                        for service, pin in r["containers"].items()),
                "Initial Linux runtime images differ")
        return
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
        and original.get("phase") == "development" and original.get("state") == "starting"
        and original.get("attempt") == r["attempt"] and original.get("compose_project") == control.project
        and original.get("control_volume") == control.volume
        and original.get("helper_container") == "fullmag-control-" + r["attempt"], "Original operation differs")
    require(original.get("inputs", {}).get("source_root") == str(source)
        and r["source_root"] == str(source) and r["compose_project"] == control.project,
        "Source or project differs")
    require(original.get("config_sha256") is None and "backend_started_at" not in original,
        "Publication was already observed")
    require(document.get("name") == control.project and set(document.get("services", {})) == {"backend", "frontend"},
        "Retained Compose differs")
    require(document["services"]["backend"].get("environment", {}).get("FULLMAG_STARTUP_ENABLED") != "1",
        "Startup activation is outside this recovery")
    require(original["inputs"]["image_id"] == r["containers"]["backend"]["image"], "Backend image differs")
    for service, pin in r["containers"].items():
        require(document["services"][service]["image"] == pin["image"], "Service image differs")


def validate_container(actual, pin, service, project, *, interrupted_resume=False, gate_failure=False):
    state = actual.get("State", {})
    require(actual.get("Id") == pin["id"] and actual.get("Image") == pin["image"]
        and fingerprint(actual) == pin["fingerprint"] and digest(canonical(state)) == pin["state_sha256"],
        "Service incarnation changed: " + service)
    require(actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") == project
        and actual["Config"]["Labels"].get("com.docker.compose.service") == service,
        "Service ownership differs")
    expected_exit = ({"backend": {2}, "frontend": {255}}[service] if gate_failure
                     else ({1, 255} if interrupted_resume and service == "frontend" else {255}))
    require(state.get("Status") == "exited" and state.get("Pid") == 0 and state.get("ExitCode") in expected_exit
        and all(state.get(k) is False for k in ("Running", "Paused", "Restarting", "Dead", "OOMKilled"))
        and not state.get("Error"), "Only stopped interrupted services are supported")


def failure_result(raw, document, r, request_sha):
    result = copy.deepcopy(json.loads(raw))
    result.pop("exit_code", None)
    gate_failure = r["schema"] == GATE_FAILURE_SCHEMA
    result.update(state="failed-confirmed", finished_at=r["observed_at"],
        config_sha256=digest(canonical(document)), build_data_qualification="NOT VERIFIED",
        backend_container=r["containers"]["backend"]["id"], frontend_container=r["containers"]["frontend"]["id"],
        error=("Resume failed at frontend readiness; backend namespace later stopped after host restart"
               if r["schema"] == RESUME_SCHEMA else GATE_FAILURE_MESSAGE if gate_failure else
               "Development interrupted before package handoff; producer exit status unavailable"),
        reconciliation={"schema": r["schema"], "request_sha256": request_sha,
            "original_receipt_sha256": r["receipt_sha256"],
            "compose_binding": "retained-configuration-not-package-qualification",
            "service_exit_codes": ({"backend": 2, "frontend": 255} if gate_failure else
                                    None if r["schema"] == RESUME_SCHEMA else {"backend": 255, "frontend": 255}),
            "producer_exit_code": None, "observation_time_not_build_completion": True,
            "containers": r["containers"]})
    if r["schema"] == RESUME_SCHEMA:
        result["frontend_volume"] = document["volumes"]["frontend-build"]["name"]
        result["reconciliation"].update(
            seeded_frontend_volume=json.loads(raw)["frontend_volume"],
            service_state_digests={k: v["state_sha256"] for k, v in r["containers"].items()},
            retained_publication=r["failure"], native_runtime_recovery_required=True,
            native_state_changed=False, solve_replayed=False,
            storage_identity=r["storage_identity"], native_storage_readmission_required=True)
    elif gate_failure:
        state_root = _compose_state_root(document)
        backend_volumes = {role: _compose_volume_name(document, "backend", target) for role, target in (
            ("build", "/build"), ("package", "/opt/fullmag/package"), ("control", "/opt/fullmag/control"))}
        result.update(
            state_root=str(state_root), backend_volumes=backend_volumes,
            frontend_volume=_compose_volume_name(document, "frontend", "/state/development"),
            backend_started_at=r["gate_failure"]["backend_started_at"])
        result["reconciliation"].update(
            gate_failure=r["gate_failure"],
            package_source_commit=r["gate_failure"]["build_source_commit"],
            native_state_changed=False, session_state_changed=False, owner_changed=False,
            run_intent_created=False, services_started=False, solve_replayed=False,
            storage_identity=r["gate_failure"]["storage_identity"])
    return canonical(result) + b"\n"


def _protected_retained_mounts(original, document, r, volumes=None, *, state_root=None):
    if r["schema"] == GATE_FAILURE_SCHEMA:
        protected = {
            _compose_volume_name(document, "backend", "/build"),
            _compose_volume_name(document, "backend", "/opt/fullmag/control"),
            _compose_volume_name(document, "frontend", "/state/development"),
        }
        protected_state_root = str(state_root if state_root is not None else _compose_state_root(document))
    else:
        protected = set(original["backend_volumes"].values()) | {original["frontend_volume"]}
        protected_state_root = original["state_root"]
    if volumes is not None:
        protected.add(volumes["retained"])
    return protected, protected_state_root


def _live_mount_consumes(actual, protected_volumes, protected_state_root, *, state_alias=None):
    return any((mount.get("Name") in protected_volumes or mount.get("Source") == protected_state_root
                or (state_alias is not None and mount.get("Source") == state_alias))
               and mount.get("RW") is True for mount in actual.get("Mounts", []))


def _observe_host_clients(source, request, helper_name):
    # Legacy recoveries retain their host-wide observer. Fail-only gate recovery
    # changes this group's receipt under its operation.lock; unrelated DEV
    # clients do not consume that authority. Its private consumers and package
    # CAS are checked again while holding the lease.
    if helper_name is None and request['schema'] != GATE_FAILURE_SCHEMA:
        host_clients(source)


def observe(control, source, r, result=None, helper_name=None):
    require(not control.namespace, "Namespaced control volumes need their dedicated recovery")
    require(docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip() == r["engine_id"], "Engine changed")
    revision = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], check=True, capture_output=True).stdout.decode().strip()
    require(revision == r["source_revision"], "Source revision changed")
    for name, sha in r["controller_inputs"].items():
        require(digest((source / "scripts" / name).read_bytes()) == sha, "Controller changed: " + name)
    root = _phase(r) + "/attempts/" + r["attempt"]
    raw = read_raw(control, root + "/unknown-receipt.json", optional=True)
    if raw is None:
        raw = read_raw(control, root + "/receipt.json")
    require(digest(raw) == r["receipt_sha256"], "Original receipt changed")
    document_raw = read_raw(control, _compose_relative(r))
    require(digest(document_raw) == r["compose_sha256"], "Compose changed")
    original, document = json.loads(raw), json.loads(document_raw)
    validate_original(original, document, r, control, source)
    attempt_root = "development/attempts/" + (r["base_attempt"] if r["schema"] == RESUME_SCHEMA else r["attempt"])
    for name, sha in r["attempt_documents"].items():
        require(digest(read_raw(control, attempt_root + "/" + name)) == sha, "Attempt document changed: " + name)
    volumes = None
    if r["schema"] == RESUME_SCHEMA:
        require(Path("/proc/sys/kernel/random/boot_id").read_text().strip() == r["host_boot_id"], "WSL boot changed")
        volumes = _resume_documents(control, original, document, r, source)

    import docker_volume_dev as dev
    state = (_compose_state_root(document) if r["schema"] == GATE_FAILURE_SCHEMA
             else Path(original["state_root"]))
    if r["schema"] == RESUME_SCHEMA:
        _interrupted_resume_certificate(state, document, r)
    else:
        dev._retained_certificate(state, document)
    require(digest(dev._certificate_path(state).read_bytes()) == r["storage_certificate_sha256"], "Storage certificate changed")
    gate_runtime_records = None
    if r["schema"] == GATE_FAILURE_SCHEMA:
        host = dev._session_host()
        certificate_raw = host.read_owned_regular(dev._certificate_path(state))
        owner_raw = host.read_owned_regular(state / host.OWNER_NAME)
        sentinel_raw = host.read_owned_regular(state / ".linux-native-sentinel")
        identity = r["gate_failure"]["storage_identity"]
        state_stat = state.stat()
        require(state_stat.st_ino == identity["root_inode"]
                and state_stat.st_dev == identity["retained_device"]
                == identity["observed_device"],
                "Initial Linux state root device/inode changed")
        validate_gate_host_documents(
            certificate_raw, owner_raw, sentinel_raw, r, r["containers"]["backend"]["image"],
            r["engine_id"], dev.local_volume(state),
        )
        gate_runtime_records = {
            path: read_raw(control, path, optional=True) for path in GATE_RUNTIME_ABSENT_PATHS
        }
        validate_gate_runtime_absence(state, gate_runtime_records)
    result_sha = digest(result) if result is not None else None
    for path, expected in ((root + "/receipt.json", r["receipt_sha256"]),
                           (_phase(r) + "/current.json", r["current_sha256"]),
                           (_phase(r) + "/verified.json", r["verified_sha256"])):
        current = read_raw(control, path, optional=True)
        allowed = {expected} | ({result_sha} if result_sha and not path.endswith("verified.json") else set())
        require((digest(current) if current is not None else None) in allowed, "Durable pointer changed: " + path)
    terminal = read_raw(control, root + "/terminal.json", optional=True)
    require(terminal is None or result is not None and terminal == result, "A different terminal exists")
    active = read_raw(control, "active")
    require(active == (r["attempt"] + "\n").encode() and digest(active) == r["active_sha256"], "Active owner changed")
    require(_probe_helper_absence(original["helper_container"]) == r["helper_absence_sha256"], "Original helper is present")
    group_ids = docker_capture("ps", "--all", "--no-trunc", "--filter", "label=com.docker.compose.project=" + control.project,
                              "--format", "{{.ID}}").stdout.decode().split()
    actuals = json.loads(docker_capture("inspect", *group_ids).stdout) if group_ids else []
    app_ids = set()
    for actual in actuals:
        if helper_name and actual.get("Name") == "/" + helper_name:
            continue
        service = actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service")
        require(service in r["containers"], "Unexpected group resource retained")
        validate_container(actual, r["containers"][service], service, control.project,
                           interrupted_resume=r["schema"] == RESUME_SCHEMA,
                           gate_failure=r["schema"] == GATE_FAILURE_SCHEMA)
        if r["schema"] == GATE_FAILURE_SCHEMA:
            validate_gate_container_mounts(actual, service, document, state)
        if r["schema"] == GATE_FAILURE_SCHEMA and service == "backend":
            require(actual["State"].get("StartedAt") == r["gate_failure"]["backend_started_at"],
                    "Backend initial-gate incarnation start time differs")
            package = _stopped_package_documents(actual, r)
            require(package == {"receipt_sha256": r["gate_failure"]["package_receipt_sha256"],
                                "provenance_sha256": r["gate_failure"]["provenance_sha256"]},
                    "Initial-gate package publication CAS changed")
        if volumes is not None:
            mounts = {m.get("Destination"): m for m in actual.get("Mounts", [])}
            if service == "backend":
                require(actual["State"].get("StartedAt") == original["backend_started_at"], "Backend namespace start differs")
                for destination, role in (("/build", "build"), ("/opt/fullmag/package", "package"), ("/opt/fullmag/control", "control")):
                    mount = mounts.get(destination, {})
                    require(mount.get("Type") == "volume" and mount.get("RW") is True
                            and mount.get("Name") == original["backend_volumes"][role], "Backend volume differs: " + role)
                publication = _stopped_package_documents(actual)
                require(publication == {k: r["failure"][k] for k in publication}, "Retained publication CAS changed")
            else:
                mount = mounts.get("/state/development", {})
                require(mount.get("Type") == "volume" and mount.get("RW") is True
                        and mount.get("Name") == volumes["retained"], "Retained frontend mount differs")

        app_ids.add(actual["Id"])
    require(app_ids == {pin["id"] for pin in r["containers"].values()}, "Service inventory differs")
    if r["schema"] == SCHEMA:
        for filename in ("backend-build-receipt.json", "provenance.json", "handoff-log.json"):
            require(read_raw(control, root + "/" + filename, optional=True) is None, "Package handoff was observed")
    if r["schema"] == GATE_FAILURE_SCHEMA:
        logs = bounded_capture(docker_argv("logs", r["containers"]["backend"]["id"]),
                               timeout=90, maximum=MAX_LOG_BYTES)
        require(logs.returncode == 0, "Pinned stopped backend log could not be read")
    else:
        logs = docker_capture("logs", r["containers"]["backend"]["id"])
    raw_logs = logs.stdout + logs.stderr
    require(len(raw_logs) <= (MAX_LOG_BYTES if r["schema"] == GATE_FAILURE_SCHEMA else 33554432)
        and digest(raw_logs) == r["backend_log_sha256"], "Backend log changed or exceeds its pin")
    if r["schema"] == GATE_FAILURE_SCHEMA:
        validate_gate_log(raw_logs)
    else:
        require(r["schema"] == RESUME_SCHEMA or b"phase=start state=handoff" not in raw_logs,
                "Package handoff was observed")
    running = docker_capture("ps", "--no-trunc", "--format", "{{.ID}}").stdout.decode().split()
    retained_volumes, retained_state_root = _protected_retained_mounts(
        original, document, r, volumes, state_root=state if r["schema"] == GATE_FAILURE_SCHEMA else None)
    state_alias = (document['services']['backend'].get('x-fullmag-daemon-binds', {}).get('/state')
                   if r['schema'] == GATE_FAILURE_SCHEMA else None)
    for actual in (json.loads(docker_capture("inspect", *running).stdout) if running else []):
        if helper_name and actual.get("Name") == "/" + helper_name:
            continue
        require(not _live_mount_consumes(actual, retained_volumes, retained_state_root, state_alias=state_alias),
            "A live container consumes retained volumes")
    # This scanner identifies our held Docker helper as a mutating client.
    # Scan before acquiring it; canonical admissions thereafter share its flock.
    _observe_host_clients(source, r, helper_name)
    return raw, document


def transaction_script(control, r, request_path, request_sha, result_path, result_sha):
    phase = _phase(r)
    root = phase + "/attempts/" + r["attempt"]
    q = shlex.quote
    checks = []
    for path, allowed in (("active", [r["active_sha256"]]), (request_path, [request_sha]),
        (result_path, [result_sha]), (_compose_relative(r), [r["compose_sha256"]]),
        (root + "/receipt.json", [r["receipt_sha256"], result_sha]),
        (phase + "/current.json", [r["current_sha256"], result_sha]),
        (phase + "/verified.json", [r["verified_sha256"]]),
        (root + "/terminal.json", [None, result_sha]), (root + "/unknown-receipt.json", [None, r["receipt_sha256"]])):
        path = control.path(path)
        alternatives = ["test \"$observed\" = " + q(x) for x in allowed if x is not None]
        if None in allowed:
            alternatives.append("test \"$observed\" = absent")
        checks.append("observe " + q(path) + "; { " + " || ".join(alternatives) + "; }")
    documents = {"development/attempts/" + (r["base_attempt"] if r["schema"] == RESUME_SCHEMA else r["attempt"]) + "/" + name: sha
                 for name, sha in r["attempt_documents"].items()}
    if r["schema"] == RESUME_SCHEMA:
        documents.update({"frontend/development-inputs.json": r["failure"]["inputs_sha256"],
            "development/attempts/" + r["base_attempt"] + "/terminal.json": r["failure"]["previous_receipt_sha256"],
            "backend/runtime-provenance.json": r["failure"]["provenance_sha256"]})
    for path, sha in documents.items():
        checks.append("observe " + q(control.path(path)) + "; test \"$observed\" = " + q(sha))
    verification = "\n".join(checks)
    return """umask 027
regular() { test -f "$1"; test ! -L "$1"; test "$(readlink -f "$1")" = "$1"; test "$(stat -c %h "$1")" = 1; }
observe() { if test -e "$1"; then regular "$1"; observed=$(sha256sum "$1" | cut -d' ' -f1); else test ! -L "$1"; observed=absent; fi; }
regular /control/operation.lock
exec 9<>/control/operation.lock
flock -n 9
""" + verification + "\nprintf 'READY\\n'\nIFS= read -r decision\ntest \"$decision\" = APPLY\n" + verification + "\nregular " + q(control.path(root + "/unknown-receipt.json")) + "; test \"$(sha256sum " + q(control.path(root + "/unknown-receipt.json")) + " | cut -d\' \' -f1)\" = " + q(r["receipt_sha256"]) + "\n" + """publish() { local path="$1" payload="$2" parent temp; parent="${path%/*}"; test "$(readlink -f "$parent")" = "$parent"; temp=$(mktemp "$parent/.interrupt.XXXXXXXX"); cat "$payload" > "$temp"; sync "$temp"; mv -T "$temp" "$path"; sync "$parent"; }
""" + "\n".join("publish " + q(control.path(path)) + " " + q(control.path(result_path)) for path in
        (root + "/receipt.json", phase + "/current.json", root + "/terminal.json")) + "\n" + \
        "rm -- /control/active\nsync /control\nprintf 'COMMITTED\\n'\n"


def reconcile(args):
    from docker_dev import _select_source, _compose_identity
    source, layout = _select_source(Path(args.source_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    cfg = toolchain_configuration(source, identity)
    control = BuildControl(identity, cfg["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    request_raw = read_raw(control, args.request)
    require(digest(request_raw) == args.request_sha256, "Request CAS differs")
    r = json.loads(request_raw); validate_request(r)
    require(digest(Path(__file__).read_bytes()) == r["controller_sha256"], "Recovery controller differs")
    base = _phase(r) + "/attempts/" + r["attempt"]
    original_raw = read_raw(control, base + "/unknown-receipt.json", optional=True)
    if original_raw is None:
        original_raw = read_raw(control, base + "/receipt.json")
    require(digest(original_raw) == r["receipt_sha256"], "Original receipt CAS differs")
    document = json.loads(read_raw(control, _compose_relative(r)))
    result = failure_result(original_raw, document, r, args.request_sha256)
    if read_raw(control, "active", optional=True) is None:
        require(read_raw(control, base + "/terminal.json", optional=True) == result
            and read_raw(control, base + "/receipt.json") == result, "No matching completed recovery")
        print(json.dumps({"state": "failed-confirmed", "replay": True, "services_started": False, "archived_receipt_confirmation_only": True}))
        return
    observe(control, source, r, result)
    result_path = "verification/" + _phase(r) + "-interrupted/" + args.request_sha256 + "/result.json"
    write_immutable(control, result_path, result)
    script = transaction_script(control, r, args.request, args.request_sha256, result_path, digest(result))
    helper_name = "fullmag-" + _phase(r) + "-reconcile-" + r["attempt"]
    helper = subprocess.Popen(control.helper_args(script, name=helper_name), stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        require(control._line(helper) == "READY", "Recovery lease was not acknowledged")
        observe(control, source, r, result, helper_name)
        if args.preview:
            helper.stdin.close()
            require(helper.wait(timeout=30) != 0, "Preview unexpectedly committed")
            print(json.dumps({"state": "validated-only", "result_sha256": digest(result), "native_state_changed": False}))
            return
        write_immutable(control, base + "/unknown-receipt.json", original_raw)
        helper.stdin.write(b"APPLY\n"); helper.stdin.flush(); helper.stdin.close()
        require(control._line(helper) == "COMMITTED", "Recovery outcome unknown; replay exact request")
        require(helper.wait(timeout=30) == 0, "Recovery helper failed")
    finally:
        if helper.stdin and not helper.stdin.closed:
            helper.stdin.close()
    require(read_raw(control, base + "/terminal.json") == result and read_raw(control, "active", optional=True) is None,
            "Recovery completion not confirmed")
    print(json.dumps({"state": "failed-confirmed", "result_sha256": digest(result), "services_started": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(); args.preview = not args.apply
    reconcile(args)

if __name__ == "__main__":
    main()
