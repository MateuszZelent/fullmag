"""Repair one stopped DEV control lease without changing sessions or results.

The repair is intentionally control-only. It records a bounded proof of the
stopped namespace, publishes immutable intent/completion records under the
existing operation lock, and removes only the exact stale ``active`` marker.
It never resumes the original activation/iteration or writes to user storage.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import time
from collections.abc import Mapping
from typing import Any

from docker_build_control import (
    BuildControlError,
    MAX_DOCUMENT_BYTES,
    bounded_capture,
    canonical,
    compose_capture,
    control_read_script,
    docker_capture,
    docker_argv,
)

SCHEMA = "fullmag.docker-offline-control-reconciliation.v1"
OPERATION_SCHEMA = "fullmag.docker-build-operation.v1"
CURRENT = "offline-reconciliation/current.json"
MAX_CONTROL_RECORD_BYTES = min(MAX_DOCUMENT_BYTES, 2 * 1024 * 1024)
MAX_STORE_FILES = 50_000
MAX_STORE_DIRECTORIES = 20_000
MAX_STORE_METADATA_BYTES = 4 * 1024 * 1024
MAX_STORE_FILE_BYTES = 8 * 1024 * 1024 * 1024 * 1024
MAX_RUNS = 256
MAX_TASKS = 4096
MAX_OPERATION_RECORD_BYTES = 512 * 1024
ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
CONTAINER_ID_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_ID_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
TERMINAL_TASK_STATES = frozenset({
    "succeeded", "failed", "cancelled", "canceled", "completed", "failed_confirmed",
})
_OWNER_IDENTITY_FIELDS = (
    "schema_version", "owner_token", "process_start_token", "pid", "host",
    "target_id", "protocol",
)
_RECREATE_RESUME_MUTABLE_PINS = frozenset({
    "runtime-control/runtime-service/process-tree.json",
    "runtime-control/runtime-services/OWNER.json",
})


def _fail(message: str) -> BuildControlError:
    return BuildControlError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _hash(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None or set(value) == {"0"}:
        raise _fail(label + " is not a nonzero lowercase SHA-256")
    return value


def _attempt(value: object, label: str) -> str:
    if not isinstance(value, str) or ATTEMPT_RE.fullmatch(value) is None:
        raise _fail(label + " is not a 32-character operation token")
    return value


def _container_id(value: object, label: str) -> str:
    if not isinstance(value, str) or CONTAINER_ID_RE.fullmatch(value) is None or set(value) == {"0"}:
        raise _fail(label + " is not a Docker container ID")
    return value


def _image_id(value: object, label: str) -> str:
    if not isinstance(value, str) or IMAGE_ID_RE.fullmatch(value) is None or set(value[7:]) == {"0"}:
        raise _fail(label + " is not an immutable image ID")
    return value


def _strict_json(raw: bytes, label: str) -> dict[str, Any]:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    try:
        value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=unique)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise _fail(label + " is not valid bounded JSON") from error
    if not isinstance(value, dict):
        raise _fail(label + " must be a JSON object")
    return value


def _relative(relative: object, label: str = "control record") -> str:
    if not isinstance(relative, str) or not relative or len(relative) > 1024:
        raise _fail(label + " path is not bounded")
    path = PurePosixPath(relative)
    if (path.is_absolute() or str(path) != relative or ".." in path.parts
            or any(part in {"", "."} for part in path.parts)
            or any(ord(character) < 32 or ord(character) == 127 for character in relative)):
        raise _fail(label + " path escapes the selected control root")
    return relative


def _read_only_control_args(control, script: str) -> list[str]:
    """Build an inspection helper whose control and registry mounts are read-only."""
    command = list(control.helper_args(script))
    mount_indices = [index + 1 for index, value in enumerate(command[:-1]) if value == "--mount"]
    control_mounts = []
    for index in mount_indices:
        options = command[index].split(",")
        if "dst=/control" in options:
            control_mounts.append((index, options))
    if len(control_mounts) != 1:
        raise _fail("Read-only control helper does not have one exact control-volume mount")
    index, options = control_mounts[0]
    if (options[0] != "type=volume" or "src=" + str(control.volume) not in options
            or "rw" in options or options.count("dst=/control") != 1):
        raise _fail("Read-only control helper volume identity is malformed")
    if "readonly" not in options:
        options.append("readonly")
    command[index] = ",".join(options)
    for mount_index in mount_indices:
        options = command[mount_index].split(",")
        if "dst=/registry" in options and "readonly" not in options:
            raise _fail("Read-only namespace registry mount is writable")
    return command


def _control_raw(control, relative: str, *, optional: bool = False,
                 maximum: int = MAX_CONTROL_RECORD_BYTES) -> bytes | None:
    relative = _relative(relative)
    read_raw = getattr(control, "read_raw", None)
    if callable(read_raw):
        try:
            raw = read_raw(relative, optional=optional)
        except FileNotFoundError:
            if optional:
                return None
            raise _fail("Required control record is missing: " + relative)
        if raw is None:
            return None
        if not isinstance(raw, bytes) or len(raw) > maximum:
            raise _fail("Control record exceeds its size bound: " + relative)
        return raw
    result = bounded_capture(
        _read_only_control_args(control, control_read_script(control.path(relative), maximum=maximum)),
        data=b"", timeout=90, maximum=maximum + 64 * 1024,
    )
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace")[-1024:]
        raise _fail("Cannot authenticate control record " + relative + " (returncode "
                    + str(result.returncode) + "): " + detail)
    if len(result.stdout) > maximum:
        raise _fail("Control record exceeds its size bound: " + relative)
    return bytes(result.stdout)


def _control_json(control, relative: str, *, optional: bool = False) -> tuple[dict[str, Any] | None, bytes | None]:
    raw = _control_raw(control, relative, optional=optional)
    return (None, None) if raw is None else (_strict_json(raw, relative), raw)


def _control_absence_probe_script(relative: str, *, root: str = "/control") -> str:
    """Build a path walk that accepts the first missing component only."""
    relative = _relative(relative)
    if not isinstance(root, str) or not root.startswith("/"):
        raise _fail("Control absence probe root is not a canonical absolute path")
    root_path = PurePosixPath(root)
    if (str(root_path) != root or ".." in root_path.parts
            or any(ord(character) < 32 or ord(character) == 127 for character in root)):
        raise _fail("Control absence probe root is not a canonical absolute path")
    root_q = shlex.quote(root)
    checks = [f'''check_directory() {{
    local path="$1"
    test ! -L "$path"
    test -d "$path"
    test -r "$path"
    test -x "$path"
    test "$(readlink -f "$path")" = "$path"
}}
check_component() {{
    local path="$1" leaf="$2" error
    if error="$(LC_ALL=C stat -c %F -- "$path" 2>&1 >/dev/null)"; then
        test ! -L "$path"
        if test "$leaf" = 1; then
            exit 45
        fi
        check_directory "$path"
    else
        # Its parent was just checked as an accessible real directory, so a
        # failed lstat is accepted only for an explicit ENOENT. Dangling links
        # and any other lookup failure remain integrity errors.
        case "$error" in
          *": No such file or directory") ;;
          *) exit 45 ;;
        esac
        test ! -L "$path"
        test ! -e "$path"
        exit 0
    fi
}}
check_directory {root_q}''']
    current = root
    parts = PurePosixPath(relative).parts
    for index, part in enumerate(parts):
        current = current.rstrip("/") + "/" + part
        checks.append(f"check_component {shlex.quote(current)} {1 if index == len(parts) - 1 else 0}")
    return "; ".join(checks)


def _confirm_control_file_absent(control, relative: str) -> None:
    """Confirm absence under accessible, non-symlink parents through first gap."""
    relative = _relative(relative)
    script = _control_absence_probe_script(relative)
    result = bounded_capture(_read_only_control_args(control, script),
                             data=b"", timeout=90, maximum=64 * 1024)
    if result.returncode:
        raise _fail("Optional control record absence was not confirmed (returncode "
                    + str(result.returncode) + "): "
                    + result.stderr.decode("utf-8", "replace")[-512:])


def _validate_operation_phase(record: object) -> str:
    if not isinstance(record, Mapping):
        raise _fail("Active operation receipt is not an object")
    phase, state = record.get("phase"), record.get("state")
    if phase == "activation" and state == "outcome-unknown-resources-retained":
        return "activation"
    if phase == "iteration" and state == "starting":
        return "iteration"
    raise _fail("Only an unknown activation or interrupted iteration control lease is eligible")


def _validate_owner_process(owner: object, process: object) -> dict[str, Any]:
    """Validate terminal owner children and bind any historical process identity."""
    if not isinstance(owner, Mapping) or not isinstance(process, Mapping):
        raise _fail("Runtime owner/process proof is missing or malformed")
    if owner.get("schema_version") != "runtime_service_owner.v1":
        raise _fail("Runtime owner schema is not recognized")
    if process.get("schema") != "fullmag.docker-process-tree.v1":
        raise _fail("Runtime process receipt schema is not recognized")
    owner_state, process_state = owner.get("state"), process.get("state")
    if process.get("runtime_pid") is not None:
        raise _fail("Runtime process proof still has a live runtime PID")
    if owner_state == "drained":
        if process_state != "drained":
            raise _fail("Drained owner does not have a drained process receipt")
        accepted_child_states = {"exited_success"}
    elif owner_state == "failed":
        if process_state not in {"failed_outcome_retained", "shutdown_unknown"}:
            raise _fail("Failed owner does not have a terminal failed process receipt")
        accepted_child_states = {"exited_success", "exited_failure"}
    else:
        raise _fail("Ready, unknown, or starting runtime owners cannot be repaired")
    if (not isinstance(owner.get("owner_token"), str) or not owner["owner_token"]
            or not isinstance(owner.get("process_start_token"), str) or not owner["process_start_token"]
            or type(owner.get("pid")) is not int or owner["pid"] <= 0
            or not isinstance(owner.get("host"), str) or not owner["host"]
            or owner.get("target_id") != "docker-all" or owner.get("protocol") != "stdin-v1"):
        raise _fail("Runtime owner identity is incomplete")
    children = owner.get("children")
    if not isinstance(children, list) or len(children) != 2:
        raise _fail("Runtime owner does not have the exact compute/preparation child set")
    by_role = {}
    for child in children:
        if not isinstance(child, Mapping):
            raise _fail("Runtime owner child proof is malformed")
        role, pid, status = child.get("role"), child.get("pid"), child.get("status")
        if (role not in {"compute", "preparation"} or role in by_role
                or type(pid) is not int or pid <= 0 or status not in accepted_child_states):
            raise _fail("Runtime owner has a live, unknown, or malformed child")
        by_role[role] = {"pid": pid, "status": status}
    if set(by_role) != {"compute", "preparation"}:
        raise _fail("Runtime owner child roles are incomplete")

    historical = None
    for field in ("service_owner", "failed_owner", "terminal_service_owner"):
        candidate = process.get(field)
        if isinstance(candidate, Mapping):
            historical = candidate
            break
    if historical is None:
        raise _fail("Process receipt has no owner identity to bind")
    if any(historical.get(field) != owner.get(field) for field in _OWNER_IDENTITY_FIELDS):
        raise _fail("Runtime owner identity differs from its process receipt")
    return {
        "owner_state": owner_state,
        "process_state": process_state,
        "owner_identity": {field: owner[field] for field in _OWNER_IDENTITY_FIELDS},
        "terminal_children": {key: by_role[key] for key in sorted(by_role)},
    }


def _validate_container(row: object, *, container_id: str, service: str,
                        project: str, image_id: str) -> dict[str, Any]:
    if (not isinstance(row, Mapping) or row.get("Id") != container_id
            or row.get("Image") != image_id or service not in {"backend", "frontend"}):
        raise _fail("Stopped service identity differs from the retained Compose receipt")
    state = row.get("State")
    config = row.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    host = row.get("HostConfig")
    if (not isinstance(state, Mapping) or not isinstance(labels, Mapping)
            or not isinstance(host, Mapping)
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service):
        raise _fail("Stopped service ownership labels are incomplete")
    started, finished = state.get("StartedAt"), state.get("FinishedAt")
    exit_code, pid = state.get("ExitCode"), state.get("Pid")
    restart_count = row.get("RestartCount")
    if (state.get("Status") != "exited" or state.get("Running") is not False
            or state.get("Paused") is not False or state.get("Restarting") is not False
            or state.get("Dead") is not False or state.get("OOMKilled") is not False
            or type(pid) is not int or pid != 0 or type(exit_code) is not int
            or not 0 <= exit_code <= 255
            or type(restart_count) is not int or restart_count < 0
            or not isinstance(started, str) or not started
            or not isinstance(finished, str) or not finished):
        raise _fail("Only an actually stopped, bounded container incarnation is eligible")
    if (host.get("PidMode") not in (None, "", "private")
            or host.get("IpcMode") not in ("", "private")
            or host.get("Privileged") is not False):
        raise _fail("Stopped service is not private-PID/private-IPC and unprivileged")
    if host.get("NetworkMode") in {"host", "none"} or host.get("Binds") not in (None, []):
        raise _fail("Stopped service uses a non-private network or unapproved host bind")
    mounts = row.get("Mounts", [])
    if not isinstance(mounts, list):
        raise _fail("Stopped service mount inspection is malformed")
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise _fail("Stopped service mount inspection is malformed")
        source = str(mount.get("Source", "")).replace("\\", "/").lower()
        target = str(mount.get("Destination", "")).replace("\\", "/").lower()
        if "docker.sock" in source or "docker.sock" in target:
            raise _fail("Stopped service has a host Docker socket mount")
    network_settings = row.get("NetworkSettings")
    if not isinstance(network_settings, Mapping):
        raise _fail("Stopped service network inspection is malformed")
    networks = network_settings.get("Networks", {})
    if not isinstance(networks, Mapping) or len(networks) != 1:
        raise _fail("Stopped service has no single private application network")
    network_names = list(networks)
    if (not isinstance(network_names[0], str) or not network_names[0]
            or host.get("NetworkMode") != network_names[0]):
        raise _fail("Stopped service network binding is not private and exact")
    return {
        "id": container_id,
        "service": service,
        "project": project,
        "image_id": image_id,
        "started_at": started,
        "finished_at": finished,
        "exit_code": exit_code,
        "pid": 0,
        "restart_count": restart_count,
        "network_names": sorted(network_names),
    }


def _validate_stopped_pair(actual: object, *, expected_ids: Mapping[str, object],
                            project: str, image_id: str) -> dict[str, Any]:
    if not isinstance(actual, Mapping) or set(actual) != {"backend", "frontend"}:
        raise _fail("Stopped backend/frontend pair is incomplete")
    if not isinstance(expected_ids, Mapping) or set(expected_ids) != {"backend", "frontend"}:
        raise _fail("Retained backend/frontend IDs are incomplete")
    evidence = {}
    for service in ("backend", "frontend"):
        identifier = _container_id(expected_ids.get(service), service + " container")
        row = actual.get(service)
        if not isinstance(row, Mapping):
            raise _fail("Stopped service inspection is malformed: " + service)
        actual_image = row.get("Image")
        _image_id(actual_image, service + " image")
        if service == "backend" and actual_image != image_id:
            raise _fail("Stopped backend image differs from the development attempt")
        evidence[service] = _validate_container(
            row, container_id=identifier, service=service, project=project,
            image_id=actual_image,
        )
    if evidence["backend"]["network_names"] != evidence["frontend"]["network_names"]:
        raise _fail("Stopped backend/frontend pair does not share the same private network")
    return evidence


def _validate_stopped_service_exposure(pair: Mapping[str, Mapping[str, Any]], *,
                                       network_name: str, port: int) -> None:
    """Validate service isolation and frontend loopback exposure with or without a bridge."""
    if not isinstance(pair, Mapping) or set(pair) != {"backend", "frontend"}:
        raise _fail("Stopped backend/frontend pair exposure is incomplete")
    backend_host = pair["backend"].get("HostConfig")
    frontend_host = pair["frontend"].get("HostConfig")
    if not isinstance(backend_host, Mapping) or not isinstance(frontend_host, Mapping):
        raise _fail("Stopped service host configuration is malformed")
    if backend_host.get("PortBindings"):
        raise _fail("Stopped backend is not unpublished")
    expected_bindings = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
    if frontend_host.get("PortBindings") != expected_bindings:
        raise _fail("Stopped frontend does not publish the exact loopback port")
    for service, host in (("backend", backend_host), ("frontend", frontend_host)):
        if (host.get("PidMode") not in (None, "", "private")
                or host.get("IpcMode") not in ("", "private")
                or host.get("NetworkMode") != network_name):
            raise _fail("Stopped " + service + " does not retain private PID/IPC and canonical network namespaces")


def _validate_private_network(row: object, *, project: str, network_name: str,
                              expected_network_label: str, allowed_ids: set[str]) -> dict[str, Any]:
    if not isinstance(row, Mapping):
        raise _fail("Retained private network inspection is malformed")
    consumers = row.get("Containers") or {}
    labels = row.get("Labels") or {}
    if not isinstance(consumers, Mapping) or not isinstance(labels, Mapping):
        raise _fail("Retained private network consumer or label inventory is malformed")
    network_id = row.get("Id")
    if (row.get("Name") != network_name or not isinstance(network_id, str)
            or not CONTAINER_ID_RE.fullmatch(network_id)
            or row.get("Driver") != "bridge"
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.network") != expected_network_label
            or any(not isinstance(identifier, str) for identifier in consumers)
            or set(consumers) - allowed_ids):
        raise _fail("Retained private network has a foreign consumer or identity")
    result = {
        "name": network_name,
        "id": network_id,
        "driver": row["Driver"],
        "labels": dict(labels),
        "consumers": sorted(consumers),
    }
    result["sha256"] = _sha256(canonical({
        "name": result["name"], "id": result["id"], "driver": result["driver"],
        "labels": result["labels"], "consumers": result["consumers"],
    }))
    return result


def _validate_catalogs(catalogs: object) -> list[dict[str, Any]]:
    if not isinstance(catalogs, list) or len(catalogs) > MAX_RUNS:
        raise _fail("Session-store run catalog inventory is malformed or too large")
    result = []
    seen_runs: set[str] = set()
    total_tasks = 0
    for entry in catalogs:
        if not isinstance(entry, Mapping):
            raise _fail("Session-store catalog entry is malformed")
        path, document = entry.get("path"), entry.get("document")
        if (not isinstance(path, str) or not isinstance(document, Mapping)
                or not path.startswith("runs/") or not path.endswith("/run_catalog.json")):
            raise _fail("Session-store run catalog path or document is invalid")
        run_id = path[len("runs/"):-len("/run_catalog.json")]
        if not run_id or "/" in run_id or run_id in seen_runs:
            raise _fail("Session-store run catalog identity is duplicate or malformed")
        seen_runs.add(run_id)
        if (document.get("schema_version") != "run_catalog.v1"
                or document.get("run_id") != run_id
                or type(document.get("revision")) is not int or document["revision"] <= 0):
            raise _fail("Session-store run catalog schema or identity differs")
        tasks = document.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            raise _fail("Session-store run catalog has no terminal task inventory")
        task_ids: set[str] = set()
        summarized = []
        for task in tasks:
            if not isinstance(task, Mapping):
                raise _fail("Session-store run catalog task is malformed")
            task_id, lifecycle = task.get("task_id"), task.get("lifecycle")
            if (not isinstance(task_id, str) or not task_id or len(task_id) > 256
                    or any(ord(char) < 32 or char in "/\\" for char in task_id)
                    or task_id in task_ids):
                raise _fail("Session-store task identity is malformed or duplicate")
            if lifecycle not in TERMINAL_TASK_STATES:
                raise _fail("Session-store has an accepted, queued, running, or unknown task")
            artifact_ids = task.get("artifact_ids", [])
            if (not isinstance(artifact_ids, list)
                    or any(not isinstance(value, str) or not value or len(value) > 256
                           or any(ord(char) < 32 or char in "/\\" for char in value)
                           for value in artifact_ids)
                    or len(set(artifact_ids)) != len(artifact_ids)):
                raise _fail("Session-store artifact references are malformed")
            task_ids.add(task_id)
            total_tasks += 1
            if total_tasks > MAX_TASKS:
                raise _fail("Session-store has too many task records for a bounded proof")
            summarized.append({"task_id": task_id, "lifecycle": lifecycle,
                               "artifact_ids": sorted(artifact_ids)})
        if document.get("state") is not None and document.get("state") not in TERMINAL_TASK_STATES:
            raise _fail("Session-store run catalog is not terminal")
        result.append({"run_id": run_id, "path": path, "revision": document["revision"],
                       "tasks": summarized})
    return sorted(result, key=lambda item: item["run_id"])


def _safe_store_root(value: object) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise _fail("Session-store root is not a path")
    root = Path(value)
    if not root.is_absolute() or ".." in root.parts or root.is_symlink():
        raise _fail("Session-store root must be absolute and unlinked")
    try:
        resolved = root.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise _fail("Session-store root cannot be resolved") from error
    if resolved != root or not root.is_dir():
        raise _fail("Session-store root is missing, linked, or not a directory")
    return root


def _read_store_file(root: Path, relative: str, *, maximum: int = MAX_STORE_METADATA_BYTES) -> tuple[bytes, os.stat_result]:
    relative = _relative(relative, "session-store")
    path = root.joinpath(*PurePosixPath(relative).parts)
    try:
        before = path.lstat()
    except OSError as error:
        raise _fail("Cannot inspect session-store file " + relative) from error
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_size < 0 or before.st_size > maximum):
        raise _fail("Session-store metadata file is non-regular, linked, or unbounded: " + relative)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise _fail("Cannot open session-store file without following links: " + relative) from error
    try:
        opened = os.fstat(fd)
        if (opened.st_ino, opened.st_dev, opened.st_size) != (before.st_ino, before.st_dev, before.st_size):
            raise _fail("Session-store file changed while it was opened: " + relative)
        chunks, total = [], 0
        while total <= maximum:
            block = os.read(fd, min(65536, maximum + 1 - total))
            if not block:
                break
            chunks.append(block)
            total += len(block)
        if total > maximum:
            raise _fail("Session-store metadata file exceeds its size bound: " + relative)
        after = os.fstat(fd)
        if (opened.st_ino, opened.st_dev, opened.st_size, opened.st_mtime_ns) != (
                after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns):
            raise _fail("Session-store file changed while it was read: " + relative)
        return b"".join(chunks), after
    finally:
        os.close(fd)


def _metadata_file(relative: str) -> bool:
    parts = PurePosixPath(relative).parts
    lowered = tuple(part.casefold() for part in parts)
    if any(part in {"objects", "artifacts", "fields", "blobs"} for part in lowered):
        return False
    name = lowered[-1]
    return (name.endswith(".json") and (name in {
        "run_catalog.json", "run_intent.json", "start_release.json", "artifact_catalog.json",
        "writer.owner.json",
    } or any("lease" in part for part in lowered) or "receipt" in name or "manifest" in name))


def _validate_store_leases(relative: str, document: Mapping[str, Any]) -> None:
    path = PurePosixPath(relative)
    parts = path.parts
    lease_families = {
        "resource_leases": "resource_lease.v1",
        "preparation_resource_leases": "preparation_resource_lease.v1",
    }
    matches = [(index, part) for index, part in enumerate(parts)
               if part.casefold() in lease_families]
    if not matches:
        return
    if len(matches) != 1:
        raise _fail("Session-store resource lease path has repeated lease families")
    index, family = matches[0]
    if (family not in lease_families or index != 2 or len(parts) != 5
            or parts[0] != "runs" or path.suffix != ".json"):
        raise _fail("Session-store resource lease path is not canonical")
    run_id, resource_id, leaf = parts[1], parts[3], parts[4]
    token = leaf[:-5]
    component_pattern = r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}"
    if any(re.fullmatch(component_pattern, value) is None
           for value in (run_id, resource_id, token)):
        raise _fail("Session-store resource lease path identity is malformed")
    if document.get("schema_version") != lease_families[family]:
        raise _fail("Session-store resource lease schema differs from its path family")
    if (document.get("run_id") != run_id or document.get("resource_id") != resource_id
            or document.get("lease_token") != token):
        raise _fail("Session-store resource lease identity differs from its canonical path")
    if document.get("state") != "released":
        raise _fail("Session-store contains a live, uncertain, or nonreleased resource lease")


def _scope_container_inventory(global_ids: object, pair_ids: object, *,
                               helper_id: str | None = None) -> list[str]:
    """Return the selected service pair and exact authenticated helper only."""
    if (not isinstance(global_ids, list)
            or any(not isinstance(identifier, str) for identifier in global_ids)
            or len(global_ids) != len(set(global_ids))):
        raise _fail("Global Docker consumer inventory is malformed")
    for identifier in global_ids:
        _container_id(identifier, "global Docker container")
    if not isinstance(pair_ids, (list, tuple)) or len(pair_ids) != 2:
        raise _fail("Selected stopped service pair inventory is malformed")
    selected = {_container_id(identifier, "selected service container") for identifier in pair_ids}
    if len(selected) != 2:
        raise _fail("Selected stopped service pair contains duplicate IDs")
    if helper_id is not None:
        helper_id = _container_id(helper_id, "authenticated transaction helper")
        if helper_id in selected:
            raise _fail("Authenticated transaction helper aliases a selected service container")
        selected.add(helper_id)
    if not selected.issubset(set(global_ids)):
        raise _fail("Selected pair/helper is absent from the global Docker inventory")
    return sorted(selected)


def _inventory_store(store_root: object) -> dict[str, Any]:
    """Hash bounded metadata/path inventory without reading artifact payloads."""
    root = _safe_store_root(store_root)
    entries: list[dict[str, Any]] = []
    catalogs: list[dict[str, Any]] = []
    metadata_hashes: dict[str, str] = {}
    total_bytes = 0
    file_count = 0
    directory_count = 0
    def walk_error(error):
        raise _fail("Cannot enumerate the complete session-store inventory: " + str(error))
    run_root = root / "runs"
    if run_root.exists() and (run_root.is_symlink() or not run_root.is_dir()):
        raise _fail("Session-store runs root is linked or not a directory")

    for parent, directories, filenames in os.walk(
            root, topdown=True, followlinks=False, onerror=walk_error):
        parent_path = Path(parent)
        for name in list(directories):
            child = parent_path / name
            try:
                info = child.lstat()
            except OSError as error:
                raise _fail("Cannot inspect session-store directory") from error
            if not stat.S_ISDIR(info.st_mode):
                raise _fail("Session-store contains a linked or non-directory entry")
            relative = child.relative_to(root).as_posix()
            entries.append({"path": relative, "kind": "directory", "mtime_ns": info.st_mtime_ns,
                            "mode": stat.S_IMODE(info.st_mode)})
            directory_count += 1
            if len(entries) > MAX_STORE_FILES + MAX_STORE_DIRECTORIES:
                raise _fail("Session-store inventory exceeds its entry bound")
        for name in filenames:
            child = parent_path / name
            relative = child.relative_to(root).as_posix()
            try:
                before = child.lstat()
            except OSError as error:
                raise _fail("Cannot inspect session-store entry " + relative) from error
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                    or before.st_size < 0 or before.st_size > MAX_STORE_FILE_BYTES):
                raise _fail("Session-store contains a linked, non-regular, or unbounded file: " + relative)
            row = {"path": relative, "kind": "file", "size": before.st_size,
                   "mtime_ns": before.st_mtime_ns, "mode": stat.S_IMODE(before.st_mode)}
            total_bytes += before.st_size
            if total_bytes > (1 << 63) - 1:
                raise _fail("Session-store total byte count is unbounded")
            if _metadata_file(relative):
                raw, after = _read_store_file(root, relative)
                if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns) != (
                        after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns):
                    raise _fail("Session-store metadata changed during inventory: " + relative)
                digest = _sha256(raw)
                row["sha256"] = digest
                metadata_hashes[relative] = digest
                try:
                    parsed = _strict_json(raw, "Session-store metadata " + relative)
                except BuildControlError:
                    # Non-JSON support files ending in .json are rejected: their
                    # contents are part of the persistent operation proof.
                    raise
                _validate_store_leases(relative, parsed)
                if relative.startswith("runs/") and relative.endswith("/run_catalog.json"):
                    catalogs.append({"path": relative, "document": parsed})
            else:
                # Artifact and field payloads are preserved by path/size/stat
                # identity; their potentially huge bytes are not read here.
                after = child.lstat()
                if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns) != (
                        after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns):
                    raise _fail("Session-store payload changed during inventory: " + relative)
            entries.append(row)
            file_count += 1
            if file_count > MAX_STORE_FILES:
                raise _fail("Session-store file count exceeds its bound")
    if directory_count > MAX_STORE_DIRECTORIES:
        raise _fail("Session-store directory count exceeds its bound")

    owner_path = "WRITER.owner.json"
    owner_raw = metadata_hashes.get(owner_path)
    if owner_raw is None:
        raise _fail("Session-store writer owner record is missing")
    owner_bytes, _ = _read_store_file(root, owner_path)
    if _sha256(owner_bytes) != owner_raw:
        raise _fail("Session-store writer owner changed after its inventory row")
    writer_owner = _strict_json(owner_bytes, "Session-store writer owner")
    if writer_owner.get("schema") != "fullmag.writer.v1" or writer_owner.get("released") is not True:
        raise _fail("Session-store writer owner is live, unknown, or malformed")
    lock_path = root / "WRITER.lock"
    if lock_path.is_symlink() or not lock_path.is_file():
        raise _fail("Session-store writer lock file is missing or linked")
    if lock_path.stat().st_nlink != 1:
        raise _fail("Session-store writer lock file has unexpected hard links")

    run_catalogs = _validate_catalogs(catalogs)
    catalogs_by_path = {entry["path"] for entry in catalogs}
    if run_root.exists():
        for entry in os.scandir(run_root):
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                raise _fail("Session-store runs root contains a linked or non-directory entry")
            candidate = "runs/" + entry.name + "/run_catalog.json"
            if candidate not in catalogs_by_path:
                raise _fail("Session-store run directory has no immutable run catalog")
    entries.sort(key=lambda row: row["path"].encode("utf-8", "strict"))
    if sum(len(canonical(item)) for item in run_catalogs) > MAX_OPERATION_RECORD_BYTES // 2:
        raise _fail("Session-store catalog/task summary exceeds its bounded proof size")
    manifest = canonical({"entries": entries, "catalogs": run_catalogs})
    return {
        "root": str(root),
        "inventory_sha256": _sha256(manifest),
        "file_count": file_count,
        "directory_count": directory_count,
        "metadata_file_count": len(metadata_hashes),
        "total_bytes": total_bytes,
        "runs": run_catalogs,
    }


def _validate_group_ledger(document: object) -> dict[str, Any]:
    if (not isinstance(document, Mapping)
            or document.get("schema_version") != "host_resource_ledger.v4"
            or not isinstance(document.get("reservations"), list)):
        raise _fail("Group ledger schema or reservation list is unsupported")
    released = 0
    for reservation in document["reservations"]:
        if not isinstance(reservation, Mapping) or reservation.get("state") not in {
                "released", "reserved", "running", "unknown", "releasing"}:
            raise _fail("Group ledger reservation is malformed")
        if reservation.get("state") != "released":
            raise _fail("Group ledger retains a nonreleased reservation")
        released += 1
    return {"reservation_count": len(document["reservations"]),
            "released_reservation_count": released}


def _read_group_ledger(control, mount: str) -> tuple[dict[str, Any], bytes]:
    if not isinstance(mount, str) or not mount.startswith("type=volume,src=") or ",dst=/ledger,readonly" not in mount:
        raise _fail("Group ledger mount is not read-only and exact")
    command = _read_only_control_args(control, "cat /ledger/ledger/HOST_RESOURCE_LEDGER.json")
    command[command.index("--entrypoint"):command.index("--entrypoint")] = ["--mount", mount]
    result = bounded_capture(command, data=b"", timeout=90, maximum=8 * 1024 * 1024)
    if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
        raise _fail("Cannot read the exact group ledger through a read-only mount")
    raw = bytes(result.stdout)
    document = _strict_json(raw, "Group ledger")
    summary = _validate_group_ledger(document)
    return {**summary, "sha256": _sha256(raw)}, raw


def _read_group_ledger_from_helper(helper_id: str) -> tuple[dict[str, Any], bytes]:
    result = bounded_capture(
        [*docker_argv("exec"), helper_id, "/bin/bash", "-euo", "pipefail", "-c",
         "cat /ledger/ledger/HOST_RESOURCE_LEDGER.json"],
        data=b"", timeout=90, maximum=8 * 1024 * 1024,
    )
    if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
        raise _fail("Cannot revalidate group ledger under the control operation lock")
    raw = bytes(result.stdout)
    summary = _validate_group_ledger(_strict_json(raw, "Group ledger"))
    return {**summary, "sha256": _sha256(raw)}, raw


def _operation_path(phase: str, token: str) -> str:
    return f"{phase}/attempts/{token}/receipt.json"


def _development_paths(attempt: str) -> tuple[str, str, str]:
    root = "development/attempts/" + attempt
    return root + "/receipt.json", root + "/terminal.json", root + "/compose.json"


def _record_sha(raw: bytes | None) -> str | None:
    return None if raw is None else _sha256(raw)


def _read_operation(control, active_raw: bytes, *, development_attempt: str,
                    selected_source: str, config_sha256: str,
                    image_id: str, backend_id: str) -> tuple[str, str, dict[str, Any], str, bytes | None, dict[str, Any]]:
    if not active_raw.endswith(b"\n") or active_raw.count(b"\n") != 1:
        raise _fail("Active control marker is not one exact operation token")
    try:
        token = active_raw[:-1].decode("ascii", "strict")
    except UnicodeDecodeError as error:
        raise _fail("Active control marker is not ASCII") from error
    _attempt(token, "active control marker")
    candidates = []
    for phase in ("activation", "iteration"):
        path = _operation_path(phase, token)
        raw = _control_raw(control, path, optional=True)
        if raw is not None:
            candidates.append((phase, path, raw))
    if len(candidates) != 1:
        raise _fail("Active token does not name exactly one eligible activation/iteration receipt")
    phase, path, raw = candidates[0]
    record = _strict_json(raw, "Original " + phase + " operation receipt")
    if _validate_operation_phase(record) != phase:
        raise _fail("Original operation phase/state differs")
    if (record.get("schema") != OPERATION_SCHEMA or record.get("attempt") != token
            or record.get("compose_project") != control.project
            or record.get("control_volume") != control.volume
            or record.get("helper_container") != "fullmag-control-" + token):
        raise _fail("Original operation identity differs from the selected control group")
    inputs = record.get("inputs")
    if not isinstance(inputs, Mapping):
        raise _fail("Original operation has no immutable input record")
    expected_attempt = inputs.get("development_attempt") if phase == "activation" else inputs.get("attempt")
    if (expected_attempt != development_attempt or inputs.get("source_root") != selected_source
            or inputs.get("config_sha256") != config_sha256 or inputs.get("image_id") != image_id):
        raise _fail("Original operation source/development/config/image pins differ")
    if phase == "activation":
        if inputs.get("backend_container") != backend_id:
            raise _fail("Unknown activation belongs to another backend incarnation")
    elif record.get("state") != "starting":
        raise _fail("Only an interrupted iteration start receipt is eligible")
    terminal_path = f"{phase}/attempts/{token}/terminal.json"
    terminal_raw = _control_raw(control, terminal_path, optional=True)
    if terminal_raw is not None:
        raise _fail("Original operation already has a terminal record")
    helper_name = "fullmag-control-" + token
    from docker_volume_activation_reconcile import _probe_helper_absence
    helper_absence_sha = _probe_helper_absence(helper_name)
    if helper_absence_sha is None:
        raise _fail("Original operation helper still exists")
    return phase, token, record, path, terminal_raw, {
        "helper_name": helper_name,
        "helper_absence_sha256": helper_absence_sha,
    }


def _activation_marker(control, record: Mapping[str, Any]) -> tuple[str | None, bytes | None]:
    if record.get("phase") != "activation":
        return None, None
    inputs = record.get("inputs")
    if not isinstance(inputs, Mapping):
        raise _fail("Unknown activation has no immutable marker path")
    guest_path = inputs.get("activation_receipt_path")
    prefix = "/opt/fullmag/control/"
    if not isinstance(guest_path, str) or not guest_path.startswith(prefix):
        raise _fail("Unknown activation marker is outside the managed control root")
    relative = _relative(guest_path[len(prefix):], "activation marker")
    raw = _control_raw(control, relative, optional=True)
    if raw is None:
        _confirm_control_file_absent(control, relative)
        return relative, None
    marker = _strict_json(raw, "Original activation marker")
    if (marker.get("schema") != "fullmag.docker-startup-activation-receipt.v1"
            or marker.get("state") != "started"
            or marker.get("request_id") != record.get("request_id")):
        raise _fail("Original activation marker identity/state differs")
    return relative, raw


def _compose_pair(document: Mapping[str, Any], identity: Mapping[str, str], control,
                  development: Mapping[str, Any], *, state_root: Path,
                  ledger_volume: str, helper_name: str | None = None,
                  helper_id: str | None = None) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    from docker_dev_up import _validate_retained_network
    from docker_volume_dev import _validate_retained_service
    from docker_volume_empty_quarantine import _project_inventory
    from docker_compose_identity import compose_network_name, validate_source_labels

    try:
        expected_network_name = compose_network_name(control.project)
    except ValueError as error:
        raise _fail("Selected Compose project has no canonical network identity") from error
    if identity.get("network_name") != expected_network_name:
        raise _fail("Compose identity network name differs from the canonical project network")

    if helper_name is not None and (not isinstance(helper_name, str) or not helper_name
                                    or helper_id is None):
        raise _fail("A named transaction helper requires its authenticated container ID")
    if helper_name is None and helper_id is not None:
        raise _fail("An authenticated helper ID cannot be supplied without its exact name")
    if helper_id is not None:
        helper_id = _container_id(helper_id, "authenticated transaction helper")

    services = document.get("services")
    if not isinstance(services, Mapping) or set(services) != {"backend", "frontend"}:
        raise _fail("Retained Compose does not contain exactly backend/frontend")
    expected_ids = {"backend": development.get("backend_container"),
                    "frontend": development.get("frontend_container")}
    expected_ids = {service: _container_id(value, service + " development container")
                    for service, value in expected_ids.items()}
    actual_ids = {}
    for service in ("backend", "frontend"):
        output = compose_capture(document, "ps", "--all", "--quiet", service)
        values = [line.strip() for line in output.decode("utf-8", "strict").splitlines() if line.strip()]
        if len(values) != 1 or _container_id(values[0], service + " Compose identity") != expected_ids[service]:
            raise _fail("Compose does not identify the exact retained " + service)
        actual_ids[service] = values[0]
    rows = json.loads(docker_capture("inspect", *actual_ids.values()).stdout)
    if not isinstance(rows, list) or len(rows) != 2:
        raise _fail("Docker stopped pair inspection is incomplete")
    by_id = {row.get("Id"): row for row in rows if isinstance(row, Mapping)}
    if set(by_id) != set(actual_ids.values()):
        raise _fail("Docker stopped pair IDs differ from Compose")

    image_configs = {}
    image_ids = {}
    for service in ("backend", "frontend"):
        image_ref = services[service].get("image")
        if not isinstance(image_ref, str) or not image_ref:
            raise _fail("Retained Compose has no immutable " + service + " image")
        image_rows = json.loads(docker_capture("image", "inspect", image_ref).stdout)
        if len(image_rows) != 1 or not isinstance(image_rows[0].get("Config"), Mapping):
            raise _fail("Retained " + service + " image inspection is incomplete")
        image_ids[service] = _image_id(image_rows[0].get("Id"), service + " image ID")
        if service == "backend" and image_ids[service] != development.get("inputs", {}).get("image_id"):
            raise _fail("Retained backend image differs from the development receipt")
        image_configs[service] = image_rows[0]["Config"]
        row = by_id[actual_ids[service]]
        try:
            validate_source_labels(row, identity)
            _validate_retained_service(document, row, service, image_configs[service])
        except (BuildControlError, KeyError, TypeError, ValueError) as error:
            raise _fail("Retained " + service + " service config differs: " + str(error)) from error
    pair = {service: by_id[actual_ids[service]] for service in actual_ids}
    evidence = _validate_stopped_pair(
        pair,
        expected_ids=expected_ids,
        project=control.project,
        image_id=image_ids["backend"],
    )
    expected_port = _document_port(document)
    _validate_stopped_service_exposure(
        pair, network_name=identity["network_name"], port=expected_port,
    )

    owned_bridge_evidence: dict[str, Any] = {}

    def validate_owned_bridge(containers, ids, project):
        if (project != control.project or ids != actual_ids
                or set(containers) != {"backend", "frontend"}):
            raise _fail("Owned bridge validation is not bound to the selected stopped pair")
        _validate_retained_network(
            containers["backend"], containers["frontend"], ids["backend"], ids["frontend"],
            project, identity["network_name"], expected_port,
        )
        rows = json.loads(docker_capture(
            "network", "inspect", identity["network_name"],
        ).stdout)
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
            raise _fail("Retained application network inspection is incomplete")
        owned_bridge_evidence.update(_validate_private_network(
            rows[0], project=project, network_name=identity["network_name"],
            expected_network_label="fullmag", allowed_ids=set(ids.values()),
        ))

    from docker_stopped_network import observe_stopped_bridge
    try:
        observed_bridge = observe_stopped_bridge(
            pair["backend"], pair["frontend"], control.project,
            capture=docker_capture, validate_owned_bridge=validate_owned_bridge,
        )
    except BuildControlError as error:
        raise _fail("Stopped bridge identity could not be authenticated: " + str(error)) from error
    if (not isinstance(observed_bridge, Mapping)
            or observed_bridge.get("name") != identity["network_name"]
            or not isinstance(observed_bridge.get("network_id"), str)
            or CONTAINER_ID_RE.fullmatch(observed_bridge["network_id"]) is None
            or observed_bridge.get("state") not in {"owned-bridge", "absent"}):
        raise _fail("Stopped bridge observer returned malformed identity evidence")
    backend_networks = pair["backend"].get("NetworkSettings", {}).get("Networks", {})
    historical_endpoint = backend_networks.get(identity["network_name"])
    if (not isinstance(historical_endpoint, Mapping)
            or historical_endpoint.get("NetworkID") != observed_bridge["network_id"]):
        raise _fail("Stopped bridge observer differs from the service's historical network ID")
    network_evidence = dict(observed_bridge)
    if observed_bridge["state"] == "owned-bridge":
        if owned_bridge_evidence.get("id") != observed_bridge["network_id"]:
            raise _fail("Owned bridge validation differs from the historical network ID")
        network_evidence["ownership"] = owned_bridge_evidence
    elif owned_bridge_evidence:
        raise _fail("Absent bridge unexpectedly produced owned-network evidence")
    protected = {control.volume, ledger_volume}
    for value in (development.get("backend_volumes") or {}).values():
        if isinstance(value, str):
            protected.add(value)
    frontend_volume = development.get("frontend_volume")
    if isinstance(frontend_volume, str):
        protected.add(frontend_volume)
    for volume in (document.get("volumes") or {}).values():
        if isinstance(volume, Mapping) and isinstance(volume.get("name"), str):
            protected.add(volume["name"])
    state_sources = {str(state_root), str(state_root / "runs/docker-all/session-store")}
    for row in pair.values():
        for mount in row.get("Mounts", []):
            if (isinstance(mount, Mapping) and mount.get("Destination") == "/state"
                    and isinstance(mount.get("Source"), str)):
                state_sources.add(mount["Source"])
    ids = _project_inventory(
        control, {key: {"id": evidence[key]["id"]} for key in evidence},
        protected_volumes=protected, state_root=state_root, ledger_volume=ledger_volume,
        helper_name=helper_name, state_sources=sorted(state_sources),
    )
    ids = _scope_container_inventory(ids, list(actual_ids.values()), helper_id=helper_id)
    return {"containers": evidence, "network": network_evidence}, pair, ids


def _document_port(document: Mapping[str, Any]) -> int:
    from docker_dev_defaults import _document_port as document_port
    try:
        return document_port(document)
    except BuildControlError as error:
        raise _fail("Retained Compose port is invalid: " + str(error)) from error


def _group_ledger_volume(document: Mapping[str, Any], project: str) -> tuple[str, str]:
    from docker_volume_empty_quarantine import _group_ledger_mount
    try:
        return _group_ledger_mount(dict(document), project)
    except (BuildControlError, KeyError, TypeError, ValueError) as error:
        raise _fail("Retained Compose group-ledger mount is invalid: " + str(error)) from error


def _select_context(args):
    from docker_dev_up import _selected_context, _control_volume_exists
    try:
        repo_root, selected, layout, identity, control = _selected_context(args)
    except (BuildControlError, OSError, ValueError, KeyError, TypeError) as error:
        raise _fail("Cannot resolve the selected native Docker DEV group: " + str(error)) from error
    if control.namespace:
        raise _fail("Offline control repair does not select a namespace subpath")
    if not _control_volume_exists(control):
        raise _fail("Selected control volume is absent; offline repair never creates it")
    return repo_root, selected, layout, identity, control


def _resolve_state_root(state_root: object, selected: Path) -> Path:
    import fullmag_storage as storage
    from docker_dev import STORAGE_PROFILE
    try:
        layout = storage.resolve_layout(selected, STORAGE_PROFILE)
        return storage.validate_path(Path(state_root), layout["runtime_root"], "retained DEV state root")
    except (OSError, ValueError, KeyError, storage.StorageError) as error:
        raise _fail("Retained DEV state root is not resolver-owned: " + str(error)) from error


def _collect_context(args) -> dict[str, Any]:
    repo_root, selected, layout, identity, control = _select_context(args)
    development_attempt = _attempt(getattr(args, "attempt", None), "development attempt")
    operation_attempt = _attempt(getattr(args, "operation_attempt", None), "offline operation attempt")
    config_sha256 = _hash(getattr(args, "config_sha256", None), "selected Compose config digest")
    port = getattr(args, "port", None)
    if type(port) is not int or not 1 <= port <= 65535:
        raise _fail("Selected frontend port is invalid")

    development_current, development_current_raw = _control_json(control, "development/current.json")
    if (development_current.get("attempt") != development_attempt
            or development_current.get("state") != "succeeded"
            or development_current.get("compose_project") != control.project
            or development_current.get("control_volume") != control.volume):
        raise _fail("Selected development attempt is not the current successful group attempt")
    receipt_path, terminal_path, compose_path = _development_paths(development_attempt)
    development_receipt, development_receipt_raw = _control_json(control, receipt_path)
    development_terminal, development_terminal_raw = _control_json(control, terminal_path)
    document, compose_raw = _control_json(control, compose_path)
    if (development_receipt != development_terminal or development_current != development_terminal
            or development_receipt_raw != development_terminal_raw
            or development_current_raw != development_terminal_raw):
        raise _fail("Development current/receipt/terminal are not the same successful record")
    if (development_terminal.get("schema") != OPERATION_SCHEMA
            or development_terminal.get("phase") != "development"
            or development_terminal.get("state") != "succeeded"
            or development_terminal.get("attempt") != development_attempt
            or development_terminal.get("compose_project") != control.project
            or development_terminal.get("control_volume") != control.volume
            or not isinstance(document, Mapping)
            or document.get("name") != control.project):
        raise _fail("Retained development terminal/Compose identity differs")
    if _sha256(canonical(document)) != config_sha256 or development_terminal.get("config_sha256") != config_sha256:
        raise _fail("Selected Compose configuration digest differs from the successful attempt")
    inputs = development_terminal.get("inputs")
    if (not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected)
            or inputs.get("source_worktree_id") != identity.get("worktree_id")):
        raise _fail("Selected source checkout differs from the successful attempt")
    image_id = _image_id(inputs.get("image_id"), "development backend image")
    if port != _document_port(document):
        raise _fail("Requested frontend port differs from the retained Compose group")

    active_raw = _control_raw(control, "active")
    backend_id = _container_id(development_terminal.get("backend_container"), "development backend")
    phase, original_token, original, original_path, original_terminal_raw, helper = _read_operation(
        control, active_raw, development_attempt=development_attempt,
        selected_source=str(selected), config_sha256=config_sha256,
        image_id=image_id, backend_id=backend_id,
    )
    phase_terminal_path = f"{phase}/attempts/{original_token}/terminal.json"
    if original_terminal_raw is not None:
        raise _fail("Original operation terminal record is present")
    previous_phase_current = phase + "/current.json"
    previous_phase_current_raw = _control_raw(control, previous_phase_current, optional=True)
    operation_marker_path, operation_marker_raw = _activation_marker(control, original)

    process_raw = _control_raw(control, "runtime-control/runtime-service/process-tree.json")
    owner_raw = _control_raw(control, "runtime-control/runtime-services/OWNER.json")
    process = _strict_json(process_raw, "Runtime process tree")
    owner = _strict_json(owner_raw, "Runtime service owner")
    owner_evidence = _validate_owner_process(owner, process)

    state_root = _resolve_state_root(development_terminal.get("state_root"), selected)
    process_store = process.get("accepted_store")
    if process_store != "/state/runs/docker-all/session-store":
        raise _fail("Runtime process receipt does not name the managed accepted session store")
    store_root = state_root / "runs" / "docker-all" / "session-store"
    store_snapshot = _inventory_store(store_root)

    ledger_volume, ledger_mount = _group_ledger_volume(document, control.project)
    ledger_snapshot, ledger_raw = _read_group_ledger(control, ledger_mount)

    operation_receipt_path = original_path
    pins: dict[str, str | None] = {
        "active": _sha256(active_raw),
        "development/current.json": _sha256(development_current_raw),
        receipt_path: _sha256(development_receipt_raw),
        terminal_path: _sha256(development_terminal_raw),
        compose_path: _sha256(compose_raw),
        original_path: _sha256(_control_raw(control, original_path)),
        phase_terminal_path: None,
        previous_phase_current: _record_sha(previous_phase_current_raw),
        "runtime-control/runtime-service/process-tree.json": _sha256(process_raw),
        "runtime-control/runtime-services/OWNER.json": _sha256(owner_raw),
    }
    if operation_marker_path is not None:
        pins[operation_marker_path] = _record_sha(operation_marker_raw)
    engine_id = docker_capture("info", "--format", "{{.ID}}").stdout.decode("utf-8", "strict").strip()
    if not engine_id or len(engine_id) > 256:
        raise _fail("Docker engine identity is unavailable")
    pair, pair_rows, inventory_ids = _compose_pair(
        document, identity, control, development_terminal,
        state_root=state_root, ledger_volume=ledger_volume,
    )
    if pair["containers"]["backend"]["id"] != backend_id:
        raise _fail("Stopped backend ID differs from the successful development attempt")
    plan = {
        "schema": SCHEMA,
        "state": "planned",
        "operation_attempt": operation_attempt,
        "phase": phase,
        "original_operation_attempt": original_token,
        "original_operation_receipt_path": operation_receipt_path,
        "original_operation_receipt_sha256": _sha256(_control_raw(control, original_path)),
        "original_operation_terminal_path": phase_terminal_path,
        "original_operation_terminal_absent": True,
        "original_helper_name": helper["helper_name"],
        "original_helper_absence_sha256": helper["helper_absence_sha256"],
        "activation_outcome": "unknown-retained" if phase == "activation" else None,
        "iteration_outcome": "interrupted-retained" if phase == "iteration" else None,
        "development_attempt": development_attempt,
        "source_root": str(selected),
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "compose_project": control.project,
        "control_volume": control.volume,
        "config_sha256": config_sha256,
        "image_id": image_id,
        "port": port,
        "docker_engine_id": engine_id,
        "stopped_pair": pair,
        "container_inventory_ids": inventory_ids,
        "owner_process": owner_evidence,
        "owner_sha256": _sha256(owner_raw),
        "process_sha256": _sha256(process_raw),
        "state_root": str(state_root),
        "store_snapshot": store_snapshot,
        "ledger_volume": ledger_volume,
        "ledger_snapshot": ledger_snapshot,
        "control_pins": pins,
        "preserve_session_store": True,
        "preserve_original_operation_receipt": True,
        "preserve_original_terminal_records": True,
        "allow_old_request_replay": False,
        "repair_scope": "control-lease-only",
    }
    plan_sha256 = _sha256(canonical(plan))
    plan["plan_sha256"] = plan_sha256
    if len(canonical(plan)) > MAX_OPERATION_RECORD_BYTES:
        raise _fail("Offline repair plan exceeds its bounded control record size")
    # Existing pointer bytes are only accepted for the same deterministic plan,
    # which makes a crash after pointer publication resumable without changing it.
    current_raw = _control_raw(control, CURRENT, optional=True)
    if current_raw is not None:
        current = _strict_json(current_raw, "Offline reconciliation current pointer")
        if current.get("operation_attempt") != operation_attempt or current.get("plan_sha256") != plan_sha256:
            raise _fail("A different offline reconciliation proof already owns the current pointer")
    return {
        "plan": plan,
        "control": control,
        "selected": selected,
        "layout": layout,
        "identity": identity,
        "document": dict(document),
        "development": development_terminal,
        "owner": owner,
        "process": process,
        "owner_evidence": owner_evidence,
        "state_root": state_root,
        "store_root": store_root,
        "ledger_volume": ledger_volume,
        "ledger_mount": ledger_mount,
        "ledger_raw": ledger_raw,
        "pair_rows": pair_rows,
    }


def collect(args) -> dict[str, Any]:
    """Return a read-only, SHA-fenced plan for one eligible stopped group."""
    return dict(_collect_context(args)["plan"])


def _operation_records(plan: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    proof = dict(plan)
    intent = {
        "schema": SCHEMA,
        "kind": "intent",
        "state": "prepared",
        "operation_attempt": plan["operation_attempt"],
        "phase": plan["phase"],
        "plan_sha256": plan["plan_sha256"],
        "proof": proof,
    }
    intent_raw = canonical(intent) + b"\n"
    receipt = {
        "schema": SCHEMA,
        "kind": "receipt",
        "state": "completed",
        "operation_attempt": plan["operation_attempt"],
        "phase": plan["phase"],
        "plan_sha256": plan["plan_sha256"],
        "intent_sha256": _sha256(intent_raw),
        "active_released": True,
        "proof": proof,
    }
    if len(intent_raw) > MAX_OPERATION_RECORD_BYTES or len(canonical(receipt)) + 1 > MAX_OPERATION_RECORD_BYTES:
        raise _fail("Offline reconciliation intent/receipt exceeds its size bound")
    return intent, receipt


def _transaction_script(*, control_root: Path | str, active_token: str,
                        active_sha256: str, pins: Mapping[str, str | None],
                        intent: Mapping[str, Any], receipt: Mapping[str, Any],
                        lock_external: bool = False) -> tuple[str, bytes]:
    """Build a replayable fsync/CAS transaction; exposed for temp-FS tests."""
    root = str(control_root).rstrip("/")
    if not root.startswith("/"):
        raise _fail("Transaction control root must be absolute")
    token = _attempt(active_token, "active marker token")
    active_digest = _hash(active_sha256, "active marker digest")
    operation_attempt = _attempt(receipt.get("operation_attempt"), "offline operation attempt")
    if intent.get("operation_attempt") != operation_attempt:
        raise _fail("Offline transaction intent/receipt attempt differs")
    root_q = shlex.quote(root)
    active = root + "/active"
    op_root = root + "/offline-reconciliation/" + operation_attempt
    intent_path = op_root + "/intent.json"
    receipt_path = op_root + "/receipt.json"
    current_path = root + "/offline-reconciliation/current.json"
    intent_raw = canonical(intent) + b"\n"
    receipt_raw = canonical(receipt) + b"\n"
    current_raw = receipt_raw
    intent_b64 = base64.b64encode(intent_raw)
    receipt_b64 = base64.b64encode(receipt_raw)
    max_payload_line_bytes = ((MAX_OPERATION_RECORD_BYTES + 2) // 3) * 4
    if max(len(intent_b64), len(receipt_b64)) > max_payload_line_bytes:
        raise _fail("Offline transaction payload exceeds its bounded stdin line")
    preamble = intent_b64 + b"\n" + receipt_b64 + b"\n"
    entries = []
    active_seen = False
    for relative, digest in sorted(pins.items()):
        relative = _relative(relative, "transaction pin")
        path = root + "/" + relative
        if relative == "active":
            active_seen = True
            if digest != active_digest:
                raise _fail("Active marker pin differs from transaction token")
            continue
        path_q = shlex.quote(path)
        if digest is None:
            entries.append(f"test ! -L {path_q}; test ! -e {path_q}")
        else:
            _hash(digest, "pinned control record digest")
            entries.append(f"regular {path_q}; test \"$(sha256sum {path_q} | cut -d' ' -f1)\" = {shlex.quote(digest)}")
    if not active_seen:
        raise _fail("Transaction does not pin the exact active marker")
    verify_pins = "\n".join(entries)
    external_lock_script = ""
    if lock_external:
        external_lock_script = r'''regular /store/WRITER.lock
exec 10</store/WRITER.lock
flock -n -s 10
regular /ledger/ledger/HOST_RESOURCE_LEDGER.json
regular /ledger/ledger/WRITER.lock
exec 11</ledger/ledger/WRITER.lock
flock -n -s 11
if test -e /ledger/ledger/HOST_INVENTORY_OWNER.lock; then
    regular /ledger/ledger/HOST_INVENTORY_OWNER.lock
    exec 12</ledger/ledger/HOST_INVENTORY_OWNER.lock
    flock -n -s 12
fi
'''
    script = f'''set -euo pipefail
umask 027
read_payload() {{
    local target="$1" value
    IFS= read -r -n {max_payload_line_bytes + 1} value || exit 73
    test -n "$value"
    test "${{#value}}" -le {max_payload_line_bytes}
    [[ "$value" =~ ^[A-Za-z0-9+/]*={{0,2}}$ ]]
    printf '%s' "$value" | base64 -d >/dev/null
    printf -v "$target" '%s' "$value"
}}
read_payload intent_b64
read_payload receipt_b64
regular() {{ test ! -L "$1"; test -f "$1"; test "$(stat -c %h "$1")" = 1; }}
ensure_directory() {{
    local path="$1" current="/" part
    local -a components
    IFS=/ read -r -a components <<< "$path"
    for part in "${{components[@]}}"; do
        test -n "$part" || continue
        current="${{current%/}}/$part"
        test ! -L "$current"
        if test ! -e "$current"; then
            mkdir -- "$current"
            sync "${{current%/*}}"
        fi
        test -d "$current"
        test "$(readlink -f "$current")" = "$current"
    done
}}
ensure_directory {root_q}
regular() {{ test ! -L "$1"; test -f "$1"; test "$(stat -c %h "$1")" = 1; }}
regular {shlex.quote(active.rsplit("/", 1)[0] + "/operation.lock")}
exec 9>>{shlex.quote(active.rsplit("/", 1)[0] + "/operation.lock")}
flock -n 9
verify_pins() {{
{verify_pins}
}}
verify_complete() {{
    regular {shlex.quote(intent_path)}
    regular {shlex.quote(receipt_path)}
    regular {shlex.quote(current_path)}
    test "$(sha256sum {shlex.quote(intent_path)} | cut -d' ' -f1)" = {shlex.quote(_sha256(intent_raw))}
    test "$(sha256sum {shlex.quote(receipt_path)} | cut -d' ' -f1)" = {shlex.quote(_sha256(receipt_raw))}
    test "$(sha256sum {shlex.quote(current_path)} | cut -d' ' -f1)" = {shlex.quote(_sha256(current_raw))}
    verify_pins
}}
if test ! -e {shlex.quote(active)}; then
    test ! -L {shlex.quote(active)}
    verify_complete
    printf 'ALREADY-COMPLETE\\n'
    exit 0
fi
regular {shlex.quote(active)}
test "$(cat {shlex.quote(active)})" = {shlex.quote(token)}
test "$(sha256sum {shlex.quote(active)} | cut -d' ' -f1)" = {shlex.quote(active_digest)}
verify_pins
{external_lock_script}
printf 'LOCKED\\n'
IFS= read -r command || exit 71
test "$command" = COMMIT
verify_pins
publish() {{
    local path="$1" payload="$2" expected="$3" parent tmp
    parent="${{path%/*}}"
    test -n "$parent"
    ensure_directory "$parent"
    test ! -L "$path"
    if test -e "$path"; then
        regular "$path"
        test "$(sha256sum "$path" | cut -d' ' -f1)" = "$expected"
        return 0
    fi
    tmp="$(mktemp "$parent/.offline-reconcile.XXXXXXXX")"
    trap 'rm -f -- "$tmp"' EXIT
    printf '%s' "$payload" | base64 -d > "$tmp"
    regular "$tmp"
    test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$expected"
    sync "$tmp"
    mv -T -- "$tmp" "$path"
    sync "$parent"
    trap - EXIT
}}
ensure_directory {shlex.quote(op_root)}
publish {shlex.quote(intent_path)} "$intent_b64" {shlex.quote(_sha256(intent_raw))}
publish {shlex.quote(receipt_path)} "$receipt_b64" {shlex.quote(_sha256(receipt_raw))}
publish {shlex.quote(current_path)} "$receipt_b64" {shlex.quote(_sha256(current_raw))}
verify_pins
regular {shlex.quote(active)}
test "$(cat {shlex.quote(active)})" = {shlex.quote(token)}
test "$(sha256sum {shlex.quote(active)} | cut -d' ' -f1)" = {shlex.quote(active_digest)}
rm -- {shlex.quote(active)}
sync {root_q}
test ! -L {shlex.quote(active)}
test ! -e {shlex.quote(active)}
verify_complete
printf 'COMPLETED\\n'
'''
    return script, preamble


def _transaction_mounts(args: list[str], *, store_root: Path, ledger_volume: str) -> None:
    if "," in str(store_root):
        raise _fail("Session-store path cannot contain a Docker --mount delimiter")
    index = args.index("--entrypoint")
    args[index:index] = [
        "--mount", "type=bind,src=" + str(store_root) + ",dst=/store,readonly",
        "--mount", "type=volume,src=" + ledger_volume + ",dst=/ledger,readonly,volume-nocopy",
    ]


def _inspect_transaction_helper(control, helper_name: str, script: str,
                                store_root: Path, ledger_volume: str) -> str:
    from run_managed_browser import host_path

    def store_source_matches(value: object) -> bool:
        if not isinstance(value, str) or not value or not os.path.isabs(value):
            return False
        return host_path(value) == store_root.resolve()

    rows = json.loads(docker_capture("inspect", helper_name).stdout)
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
        raise _fail("Offline transaction helper inspection is ambiguous")
    row = rows[0]
    identifier = _container_id(row.get("Id"), "offline transaction helper")
    config, state, host = row.get("Config"), row.get("State"), row.get("HostConfig")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    from docker_compose_identity import source_labels
    expected_labels = {**control.labels, **source_labels(control.identity),
                       "com.docker.compose.project": control.project,
                       "com.docker.compose.service": "build-control"}
    if (row.get("Name") != "/" + helper_name or not isinstance(config, Mapping)
            or config.get("Image") != control.image or config.get("Entrypoint") != ["/bin/bash"]
            or config.get("Cmd") != ["-euo", "pipefail", "-c", control._namespace_guard(script)]
            or not isinstance(labels, Mapping)
            or any(labels.get(key) != value for key, value in expected_labels.items())
            or not isinstance(state, Mapping) or state.get("Running") is not True
            or type(state.get("Pid")) is not int or state["Pid"] <= 0
            or not isinstance(host, Mapping) or host.get("NetworkMode") != "none"
            or host.get("Privileged") is not False or host.get("ReadonlyRootfs") is not True
            or "ALL" not in (host.get("CapDrop") or [])
            or host.get("Binds") not in (None, [])):
        raise _fail("Offline transaction helper isolation or identity differs")
    host_mounts = host.get("Mounts")
    if not isinstance(host_mounts, list) or len(host_mounts) != 3:
        raise _fail("Offline transaction helper mount set is not exact")
    observed = {}
    for mount in host_mounts:
        if not isinstance(mount, Mapping):
            raise _fail("Offline transaction helper mount is malformed")
        target = mount.get("Target")
        if target in observed:
            raise _fail("Offline transaction helper has duplicate mount targets")
        observed[target] = mount
    expected = {
        "/control": ("volume", control.volume, False),
        "/store": ("bind", str(store_root), True),
        "/ledger": ("volume", ledger_volume, True),
    }
    for target, (mount_type, source, readonly) in expected.items():
        mount = observed.get(target)
        options = mount.get("VolumeOptions") if isinstance(mount, Mapping) else None
        if (not isinstance(mount, Mapping) or mount.get("Type") != mount_type
                or (not store_source_matches(mount.get("Source"))
                    if target == "/store" else mount.get("Source") != source)
                or bool(mount.get("ReadOnly", False)) is not readonly
                or (mount_type == "volume" and (not isinstance(options, Mapping)
                                                   or options.get("NoCopy") is not True))):
            raise _fail("Offline transaction helper has an unexpected mount at " + target)
    runtime_mounts = row.get("Mounts")
    if not isinstance(runtime_mounts, list) or len(runtime_mounts) != 3:
        raise _fail("Offline transaction helper runtime mounts are incomplete")
    for target, (_kind, source, readonly) in expected.items():
        found = [mount for mount in runtime_mounts if isinstance(mount, Mapping)
                 and mount.get("Destination") == target]
        if (len(found) != 1 or found[0].get("RW") is readonly
                or (target != "/store" and found[0].get("Name") != source)
                or (target == "/store" and not store_source_matches(found[0].get("Source")))):
            raise _fail("Offline transaction helper runtime access differs at " + target)
    return identifier


def _line(process: subprocess.Popen, timeout: float = 120) -> str:
    import queue
    import threading
    result: queue.Queue[bytes] = queue.Queue(maxsize=1)
    def read_line():
        try:
            result.put(process.stdout.readline() if process.stdout else b"")
        except BaseException:
            result.put(b"")
    threading.Thread(target=read_line, daemon=True).start()
    try:
        raw = result.get(timeout=timeout)
    except queue.Empty as error:
        raise _fail("Offline control helper outcome is unknown; active resources were retained") from error
    if not raw:
        detail = ""
        if process.poll() is not None and process.stderr:
            detail = process.stderr.read().decode("utf-8", "replace")[-1024:]
        raise _fail("Offline control helper exited before its durable acknowledgement: " + detail)
    return raw.decode("utf-8", "replace").strip()


def _current_live_plan(context: Mapping[str, Any], helper_name: str, helper_id: str) -> dict[str, Any]:
    plan = context["plan"]
    development = context["development"]
    pair, _, inventory_ids = _compose_pair(
        context["document"], context["identity"], context["control"], development,
        state_root=context["state_root"], ledger_volume=context["ledger_volume"],
        helper_name=helper_name, helper_id=helper_id,
    )
    inventory_without_helper = [identifier for identifier in inventory_ids if identifier != helper_id]
    if inventory_without_helper != plan["container_inventory_ids"]:
        raise _fail("Docker consumers/containers changed while the offline control lock was held")
    engine_id = docker_capture("info", "--format", "{{.ID}}").stdout.decode("utf-8", "strict").strip()
    if engine_id != plan["docker_engine_id"]:
        raise _fail("Docker engine identity changed during offline control repair")
    if pair != plan["stopped_pair"]:
        raise _fail("Stopped service incarnation/network changed while the offline control lock was held")
    store_snapshot = _inventory_store(context["store_root"])
    if store_snapshot != plan["store_snapshot"]:
        raise _fail("Session-store inventory changed while offline control lock was held")
    ledger_snapshot, ledger_raw = _read_group_ledger_from_helper(helper_id)
    if ledger_snapshot != plan["ledger_snapshot"]:
        raise _fail("Group ledger changed while offline control lock was held")
    from docker_volume_activation_reconcile import _probe_helper_absence
    absence_sha = _probe_helper_absence(plan["original_helper_name"])
    if absence_sha != plan["original_helper_absence_sha256"]:
        raise _fail("Original operation helper reappeared during offline control repair")
    return {"pair": pair, "inventory_ids": inventory_without_helper,
            "store_snapshot": store_snapshot, "ledger_snapshot": ledger_snapshot,
            "ledger_raw": ledger_raw}


def _verify_completed_record(control, receipt: object, receipt_raw: bytes,
                             expected_operation_attempt: str | None = None,
                             *, verify_all_pins: bool = True,
                             allow_active_token: str | None = None,
                             active_pin_matches: bool = True,
                             mutable_pins: frozenset[str] = frozenset()) -> dict[str, Any]:
    if not isinstance(receipt, Mapping):
        raise _fail("Offline reconciliation current pointer is malformed")
    token = _attempt(receipt.get("operation_attempt"), "offline reconciliation pointer")
    if expected_operation_attempt is not None and token != _attempt(
            expected_operation_attempt, "expected offline reconciliation attempt"):
        raise _fail("Current offline reconciliation proof belongs to another operation attempt")
    if (receipt.get("schema") != SCHEMA or receipt.get("kind") != "receipt"
            or receipt.get("state") != "completed" or receipt.get("active_released") is not True
            or receipt.get("phase") not in {"activation", "iteration"}):
        raise _fail("Offline reconciliation receipt is not complete")
    if receipt_raw != canonical(receipt) + b"\n":
        raise _fail("Offline reconciliation receipt is not canonical")
    proof = receipt.get("proof")
    if not isinstance(proof, Mapping) or proof.get("plan_sha256") != receipt.get("plan_sha256"):
        raise _fail("Offline reconciliation proof/plan identity differs")
    plan_without_sha = dict(proof)
    plan_sha = plan_without_sha.pop("plan_sha256", None)
    if _hash(plan_sha, "offline plan digest") != _sha256(canonical(plan_without_sha)):
        raise _fail("Offline reconciliation plan digest is invalid")
    if (proof.get("schema") != SCHEMA or proof.get("state") != "planned"
            or proof.get("operation_attempt") != token
            or proof.get("phase") != receipt.get("phase")
            or proof.get("control_volume") != control.volume
            or proof.get("compose_project") != control.project):
        raise _fail("Offline reconciliation proof does not belong to this control group")
    intent_path = "offline-reconciliation/" + token + "/intent.json"
    operation_receipt_path = "offline-reconciliation/" + token + "/receipt.json"
    intent_raw = _control_raw(control, intent_path)
    final_raw = _control_raw(control, operation_receipt_path)
    if final_raw != receipt_raw:
        raise _fail("Current pointer differs from its immutable operation receipt")
    intent = _strict_json(intent_raw, "Offline reconciliation intent")
    if (intent_raw != canonical(intent) + b"\n" or intent.get("schema") != SCHEMA
            or intent.get("kind") != "intent" or intent.get("state") != "prepared"
            or intent.get("operation_attempt") != token
            or intent.get("plan_sha256") != plan_sha
            or intent.get("proof") != dict(proof)
            or receipt.get("intent_sha256") != _sha256(intent_raw)):
        raise _fail("Offline reconciliation intent/receipt chain is incomplete")
    pins = proof.get("control_pins")
    if not isinstance(pins, Mapping) or pins.get("active") is None:
        raise _fail("Offline reconciliation proof has no original active marker pin")
    _hash(pins.get("active"), "original active marker digest")
    original_token = _attempt(proof.get("original_operation_attempt"), "original operation attempt")
    active = _control_raw(control, "active", optional=True)
    if allow_active_token is None:
        if active is not None:
            raise _fail("Offline reconciliation receipt exists but the active marker is still held")
    else:
        allowed_token = _attempt(allow_active_token, "authorized active operation")
        if active != (allowed_token + "\n").encode("ascii"):
            raise _fail("Current active marker does not belong to the exact authorized operation")
        if not active_pin_matches and allowed_token == original_token:
            raise _fail("A recreation operation cannot reuse the original operation lease token")
        if active_pin_matches and _sha256(active) != pins["active"]:
            raise _fail("Prepared offline proof no longer matches its original active marker CAS")
    if not mutable_pins.issubset(_RECREATE_RESUME_MUTABLE_PINS):
        raise _fail("Offline proof reader was asked to skip an unapproved mutable control pin")
    for relative, expected in pins.items():
        relative = _relative(relative, "offline proof pin")
        if relative == "active":
            if allow_active_token is None:
                if active is not None:
                    raise _fail("Offline reconciliation did not release the exact active marker")
            elif active_pin_matches and _sha256(active) != _hash(expected, "original active marker digest"):
                raise _fail("Offline reconciliation active marker pin changed")
            continue
        if verify_all_pins and relative in mutable_pins:
            _hash(expected, "control proof pin")
            continue
        raw = _control_raw(control, relative, optional=True)
        if relative == "active":
            raise _fail("Unexpected active marker pin processing state")
        elif verify_all_pins:
            if expected is None:
                if raw is not None:
                    raise _fail("A control record that was absent during repair has appeared: " + relative)
            elif raw is None or _sha256(raw) != _hash(expected, "control proof pin"):
                raise _fail("Pinned original control record changed after repair: " + relative)
    original_path = proof.get("original_operation_receipt_path")
    if original_path != _operation_path(receipt["phase"], original_token):
        raise _fail("Offline receipt original operation path is malformed")
    original_raw = _control_raw(control, original_path)
    original_digest = _hash(proof.get("original_operation_receipt_sha256"),
                            "original operation receipt digest")
    if _sha256(original_raw) != original_digest:
        raise _fail("Original operation receipt changed after offline repair")
    if verify_all_pins:
        original_terminal = _control_raw(control, proof.get("original_operation_terminal_path"), optional=True)
    else:
        original_terminal = _control_raw(control, proof.get("original_operation_terminal_path"), optional=True)
    if original_terminal is not None or proof.get("original_operation_terminal_absent") is not True:
        raise _fail("Original operation terminal record was changed or appeared")
    original = _strict_json(original_raw, "Original operation receipt")
    if (_validate_operation_phase(original) != receipt["phase"]
            or original.get("attempt") != original_token):
        raise _fail("Original operation outcome is no longer the retained eligible outcome")
    expected_outcome = "unknown-retained" if receipt["phase"] == "activation" else "interrupted-retained"
    if (receipt["phase"] == "activation" and proof.get("activation_outcome") != expected_outcome
            or receipt["phase"] == "iteration" and proof.get("iteration_outcome") != expected_outcome):
        raise _fail("Offline reconciliation does not preserve its original outcome")
    return dict(receipt)


def read_completed(control, expected_operation_attempt: str) -> dict[str, Any] | None:
    """Read the completed current proof and verify every immutable control pin."""
    expected_operation_attempt = _attempt(expected_operation_attempt, "expected offline reconciliation attempt")
    current_raw = _control_raw(control, CURRENT, optional=True)
    if current_raw is None:
        return None
    current = _strict_json(current_raw, "Offline reconciliation current pointer")
    if current.get("operation_attempt") != expected_operation_attempt:
        raise _fail("Current offline reconciliation proof belongs to another operation attempt")
    return _verify_completed_record(control, current, current_raw, expected_operation_attempt)


def _read_completed_recreation_chain(control, expected_operation_attempt: str) -> dict[str, Any]:
    """Verify immutable offline records while allowing only recreation-owned runtime pins to evolve."""
    expected_operation_attempt = _attempt(expected_operation_attempt, "expected offline reconciliation attempt")
    current_raw = _control_raw(control, CURRENT, optional=True)
    if current_raw is None:
        raise _fail("Recreation resume has no offline reconciliation proof")
    current = _strict_json(current_raw, "Offline reconciliation current pointer")
    if current.get("operation_attempt") != expected_operation_attempt:
        raise _fail("Recreation resume offline proof belongs to another operation attempt")
    return _verify_completed_record(
        control, current, current_raw, expected_operation_attempt,
        mutable_pins=_RECREATE_RESUME_MUTABLE_PINS,
    )


def validate_recreate_resume(control, operation, expected_offline_attempt: str) -> bool:
    """Bind completed offline evidence to its exact persisted successful recreation."""
    expected_offline_attempt = _attempt(
        expected_offline_attempt, "expected offline reconciliation attempt",
    )
    if not isinstance(operation, dict):
        raise _fail("Recreation resume operation receipt is malformed")
    attempt = _attempt(operation.get("attempt"), "recreation resume operation attempt")
    root = "recreate-services/attempts/" + attempt
    terminal_raw = _control_raw(control, root + "/terminal.json")
    receipt_raw = _control_raw(control, root + "/receipt.json")
    current_raw = _control_raw(control, "recreate-services/current.json")
    persisted = _strict_json(terminal_raw, "Recreation resume terminal receipt")
    if (terminal_raw != canonical(persisted) + b"\n"
            or receipt_raw != terminal_raw or current_raw != terminal_raw
            or dict(operation) != persisted):
        raise _fail("Recreation resume receipt/current pointer is not one exact persisted record")
    if (persisted.get("schema") != OPERATION_SCHEMA
            or persisted.get("phase") != "recreate-services"
            or persisted.get("state") != "succeeded"
            or persisted.get("attempt") != attempt
            or persisted.get("helper_container") != "fullmag-control-" + attempt
            or persisted.get("compose_project") != control.project
            or persisted.get("control_volume") != control.volume
            or persisted.get("fresh_state") is not False):
        raise _fail("Recreation resume operation phase/state/identity differs")
    inputs = persisted.get("inputs")
    if (not isinstance(inputs, Mapping)
            or inputs.get("offline_reconciliation") != expected_offline_attempt
            or persisted.get("offline_reconciliation") != expected_offline_attempt):
        raise _fail("Recreation resume inputs do not retain the selected offline proof")
    development_attempt = _attempt(inputs.get("attempt"), "recreation prior development attempt")
    config_digest = _hash(inputs.get("config_sha256"), "recreation configuration digest")
    proof_receipt = _read_completed_recreation_chain(control, expected_offline_attempt)
    proof = proof_receipt["proof"]
    if (development_attempt != proof.get("development_attempt")
            or config_digest != proof.get("config_sha256")
            or persisted.get("previous_state_root") != proof.get("state_root")):
        raise _fail("Recreation resume inputs differ from the immutable offline proof")
    development = _read_selected_control(
        control, "development/attempts/" + development_attempt + "/terminal.json",
    )
    if (persisted.get("retained_volumes") != development.get("backend_volumes")
            or persisted.get("retained_frontend_volume") != development.get("frontend_volume")):
        raise _fail("Recreation resume retained-volume pins differ from the prior development receipt")
    stopped_pair = proof.get("stopped_pair")
    proof_containers = stopped_pair.get("containers") if isinstance(stopped_pair, Mapping) else None
    if not isinstance(proof_containers, Mapping) or set(proof_containers) != {"backend", "frontend"}:
        raise _fail("Immutable offline proof has no exact stopped service pair")
    expected_ids = {
        service: proof_containers[service]["id"]
        for service in ("backend", "frontend")
    }
    removed = persisted.get("removed_containers")
    if (not isinstance(removed, list) or len(removed) != 2
            or any(not isinstance(identifier, str) for identifier in removed)
            or set(removed) != set(expected_ids.values())):
        raise _fail("Recreation resume did not remove the exact offline-proven service pair")
    retained_raw = _control_raw(control, root + "/retained-containers.json")
    retained = _strict_json(retained_raw, "Recreation retained-container snapshot")
    if retained_raw != canonical(retained) + b"\n" or set(retained) != {"backend", "frontend"}:
        raise _fail("Recreation retained-container snapshot is not exact and canonical")
    stopped_evidence = _validate_stopped_pair(
        retained, expected_ids=expected_ids, project=control.project,
        image_id=str(proof.get("image_id")),
    )
    if stopped_evidence != proof_containers:
        raise _fail("Recreation retained-container snapshot differs from offline proof")
    return True


def _read_completed_or_prepared_retry(control, expected_operation_attempt: str,
                                      expected_plan_sha256: object) -> dict[str, Any] | None:
    """Return durable completion or validate the exact publish-before-unlink crash state."""
    current_raw = _control_raw(control, CURRENT, optional=True)
    if current_raw is None:
        return None
    current = _strict_json(current_raw, "Offline reconciliation current pointer")
    if current.get("operation_attempt") != _attempt(
            expected_operation_attempt, "expected offline reconciliation attempt"):
        raise _fail("Current offline reconciliation proof belongs to another operation attempt")
    active = _control_raw(control, "active", optional=True)
    if active is None:
        completed = _verify_completed_record(
            control, current, current_raw, expected_operation_attempt,
        )
        _require_plan_sha(expected_plan_sha256, completed.get("plan_sha256"))
        return completed
    proof = current.get("proof")
    if not isinstance(proof, Mapping):
        raise _fail("Prepared offline reconciliation pointer has no proof")
    original_token = _attempt(proof.get("original_operation_attempt"), "original operation attempt")
    prepared = _verify_completed_record(
        control, current, current_raw, expected_operation_attempt,
        allow_active_token=original_token, active_pin_matches=True,
    )
    _require_plan_sha(expected_plan_sha256, prepared.get("plan_sha256"))
    # Do not report completion here. apply() must recollect the live preconditions
    # and replay the CAS transaction under operation.lock to release active.
    return None


def _read_any_completed(control) -> dict[str, Any] | None:
    current_raw = _control_raw(control, CURRENT, optional=True)
    if current_raw is None:
        return None
    current = _strict_json(current_raw, "Offline reconciliation current pointer")
    return _verify_completed_record(control, current, current_raw, verify_all_pins=False)


def assert_activation_allowed(control) -> None:
    """Keep an original unknown activation fenced after control-only repair."""
    receipt = _read_any_completed(control)
    if receipt is None:
        return None
    if receipt["phase"] == "activation":
        raise _fail("Original activation outcome remains unknown-retained; Solve/startup replay is fenced")
    return None


def _read_selected_control(control, relative: str) -> dict[str, Any]:
    document, raw = _control_json(control, relative)
    if not isinstance(document, Mapping) or raw is None:
        raise _fail("Required control record is missing: " + relative)
    return document


def _validate_current_operation(control, operation: object, *, expected_operation_attempt: str,
                                previous: Mapping[str, Any], config_sha256: str) -> dict[str, str]:
    """Authenticate the one live recreate-services lease allowed during validation."""
    if not isinstance(operation, dict):
        raise _fail("Leased offline validation has no current recreation operation")
    receipt = operation.get("receipt")
    if not isinstance(receipt, Mapping):
        raise _fail("Current recreation operation receipt is malformed")
    attempt = _attempt(receipt.get("attempt"), "current recreation attempt")
    expected_operation_attempt = _attempt(expected_operation_attempt, "offline reconciliation attempt")
    root = "recreate-services/attempts/" + attempt
    helper_name = "fullmag-control-" + attempt
    helper_id = _container_id(operation.get("helper_container_id"), "current recreation helper")
    inputs = receipt.get("inputs")
    if (not isinstance(inputs, Mapping)
            or receipt.get("schema") != OPERATION_SCHEMA
            or receipt.get("phase") != "recreate-services"
            or receipt.get("state") != "starting"
            or receipt.get("compose_project") != control.project
            or receipt.get("control_volume") != control.volume
            or receipt.get("helper_container") != helper_name
            or operation.get("root") != root
            or operation.get("lease_ready") is not True
            or operation.get("daemon_pending") is not False
            or ("offline_reconciliation" in receipt
                and receipt.get("offline_reconciliation") != expected_operation_attempt)
            or inputs.get("attempt") != previous.get("attempt")
            or inputs.get("config_sha256") != config_sha256
            or inputs.get("offline_reconciliation") != expected_operation_attempt):
        raise _fail("Current recreation operation phase/attempt/root/helper/inputs differ")
    try:
        canonical(inputs)
    except (TypeError, ValueError) as error:
        raise _fail("Current recreation operation inputs are not canonical JSON data") from error
    persisted_raw = _control_raw(control, root + "/receipt.json")
    persisted = _strict_json(persisted_raw, "Current recreation operation receipt")
    if persisted_raw != canonical(persisted) + b"\n":
        raise _fail("Current recreation operation receipt is not canonical")
    expected_persisted = dict(receipt)
    expected_persisted.pop("offline_reconciliation", None)
    if persisted != expected_persisted:
        raise _fail("Current recreation receipt differs from its persisted admission record")
    active = _control_raw(control, "active")
    if active != (attempt + "\n").encode("ascii"):
        raise _fail("Current active marker does not bind the recreation attempt")
    inspect_helper = getattr(control, "_inspect_operation_helper", None)
    if not callable(inspect_helper):
        raise _fail("Current recreation helper cannot be authenticated")
    try:
        observed_id = inspect_helper(operation, expected_id=helper_id)
    except BuildControlError as error:
        raise _fail("Current recreation helper identity is not authenticated: " + str(error)) from error
    if observed_id != helper_id:
        raise _fail("Current recreation helper ID differs from its pinned operation")
    return {"attempt": attempt, "helper_name": helper_name, "helper_id": helper_id, "root": root}


def _validate_container_inventory(inventory_ids: object, proof: Mapping[str, Any],
                                  current_operation: Mapping[str, str] | None) -> None:
    if (not isinstance(inventory_ids, list)
            or any(not isinstance(identifier, str) for identifier in inventory_ids)
            or inventory_ids != sorted(set(inventory_ids))):
        raise _fail("Docker consumer inventory is malformed")
    if current_operation is None:
        if inventory_ids != proof.get("container_inventory_ids"):
            raise _fail("Docker consumer/container inventory changed after offline repair")
    elif current_operation.get("helper_id") not in inventory_ids:
        raise _fail("Exact leased recreation helper is absent from the protected consumer inventory")


def _revalidate_for_recreate(control, receipt: Mapping[str, Any], previous: Mapping[str, Any],
                             document: Mapping[str, Any], actual: object,
                             selected: object, config_sha256: str,
                             current_operation: Mapping[str, str] | None = None) -> bool:
    proof = receipt["proof"]
    if (not isinstance(selected, (str, os.PathLike))
            or os.path.normcase(os.path.normpath(str(selected)))
               != os.path.normcase(os.path.normpath(str(proof.get("source_root"))))):
        raise _fail("Offline proof source checkout differs from the selected recreation source")
    _hash(config_sha256, "recreation Compose digest")
    if config_sha256 != proof.get("config_sha256") or _sha256(canonical(document)) != config_sha256:
        raise _fail("Offline proof Compose configuration differs from recreation")
    if not isinstance(previous, Mapping):
        raise _fail("Offline proof has no previous development receipt")
    previous_inputs = previous.get("inputs")
    if (previous.get("attempt") != proof.get("development_attempt")
            or previous.get("state") != "succeeded"
            or not isinstance(previous_inputs, Mapping)
            or previous_inputs.get("source_root") != proof.get("source_root")
            or previous_inputs.get("image_id") != proof.get("image_id")
            or previous.get("config_sha256") != config_sha256):
        raise _fail("Offline proof previous development attempt/source/image/config differs")
    if previous.get("backend_container") != proof["stopped_pair"]["containers"]["backend"]["id"]:
        raise _fail("Offline proof backend ID differs from the previous development receipt")

    retained = _read_selected_control(
        control, "development/attempts/" + str(proof["development_attempt"]) + "/compose.json"
    )
    if retained != dict(document):
        raise _fail("Recreation Compose differs from the pinned development Compose")
    current = _read_selected_control(control, "development/current.json")
    if (current.get("attempt") != proof.get("development_attempt")
            or current.get("state") != "succeeded"
            or current.get("config_sha256") != config_sha256):
        raise _fail("Development current receipt changed after offline repair")

    process_raw = _control_raw(control, "runtime-control/runtime-service/process-tree.json")
    owner_raw = _control_raw(control, "runtime-control/runtime-services/OWNER.json")
    process = _strict_json(process_raw, "Runtime process tree")
    owner = _strict_json(owner_raw, "Runtime service owner")
    owner_evidence = _validate_owner_process(owner, process)
    if (owner_evidence != proof.get("owner_process")
            or _sha256(owner_raw) != proof.get("owner_sha256")
            or _sha256(process_raw) != proof.get("process_sha256")):
        raise _fail("Runtime owner/process proof changed after offline repair")

    from docker_dev import STORAGE_PROFILE
    import fullmag_storage as storage
    try:
        layout = storage.resolve_layout(Path(selected), STORAGE_PROFILE)
        state_root = storage.validate_path(Path(proof.get("state_root")), layout["runtime_root"],
                                           "offline retained state root")
    except (OSError, ValueError, KeyError, storage.StorageError) as error:
        raise _fail("Offline retained state root is not resolver-owned: " + str(error)) from error
    store_snapshot = _inventory_store(state_root / "runs" / "docker-all" / "session-store")
    if store_snapshot != proof.get("store_snapshot"):
        raise _fail("Offline session-store metadata/artifact inventory changed")

    ledger_volume, ledger_mount = _group_ledger_volume(document, control.project)
    if ledger_volume != proof.get("ledger_volume"):
        raise _fail("Offline proof group-ledger volume differs from retained Compose")
    ledger_snapshot, _ = _read_group_ledger(control, ledger_mount)
    if ledger_snapshot != proof.get("ledger_snapshot"):
        raise _fail("Offline group ledger/reservation proof changed")

    expected_ids = {name: proof["stopped_pair"]["containers"][name]["id"]
                    for name in ("backend", "frontend")}
    actual_evidence = _validate_stopped_pair(
        actual, expected_ids=expected_ids, project=control.project,
        image_id=str(proof.get("image_id")),
    )
    if actual_evidence != proof["stopped_pair"]["containers"]:
        raise _fail("Current actual stopped backend/frontend incarnation differs from offline proof")
    # Re-observe daemon state and every consumer before consuming the proof.
    live_pair, _, inventory_ids = _compose_pair(
        document, control.identity, control, previous,
        state_root=state_root, ledger_volume=ledger_volume,
        helper_name=(current_operation.get("helper_name") if current_operation is not None else None),
        helper_id=(current_operation.get("helper_id") if current_operation is not None else None),
    )
    if live_pair != proof.get("stopped_pair"):
        raise _fail("Live stopped pair differs from offline proof")
    _validate_container_inventory(inventory_ids, proof, current_operation)
    from docker_volume_activation_reconcile import _probe_helper_absence
    if _probe_helper_absence(proof.get("original_helper_name")) != proof.get("original_helper_absence_sha256"):
        raise _fail("Original operation helper is no longer absent")
    return True


def validate_for_recreate(control, previous, document, actual, selected, config_sha256,
                          expected_operation_attempt: str | None = None,
                          current_operation: object | None = None) -> bool:
    """Validate an explicitly selected completed proof for one recreation."""
    if expected_operation_attempt is None:
        return False
    lease_context = None
    if current_operation is not None:
        if not isinstance(previous, Mapping):
            raise _fail("Leased recreation has no previous development receipt")
        lease_context = _validate_current_operation(
            control, current_operation,
            expected_operation_attempt=expected_operation_attempt,
            previous=previous, config_sha256=config_sha256,
        )
    current_raw = _control_raw(control, CURRENT, optional=True)
    if current_raw is None:
        return False
    current = _strict_json(current_raw, "Offline reconciliation current pointer")
    if current.get("operation_attempt") != _attempt(
            expected_operation_attempt, "expected offline reconciliation attempt"):
        raise _fail("Current offline reconciliation proof belongs to another operation attempt")
    if lease_context is None:
        receipt = _verify_completed_record(control, current, current_raw, expected_operation_attempt)
    else:
        receipt = _verify_completed_record(
            control, current, current_raw, expected_operation_attempt,
            allow_active_token=lease_context["attempt"], active_pin_matches=False,
        )
    return _revalidate_for_recreate(
        control, receipt, previous, document, actual, selected, config_sha256,
        current_operation=lease_context,
    )


def _read_locked_helper(process: subprocess.Popen, expected_line: str) -> None:
    line = _line(process)
    if line != expected_line:
        raise _fail("Offline transaction helper did not acquire its locked state: " + line)


def _release_helper(process: subprocess.Popen, *, commit: bool) -> tuple[str, int]:
    if process.stdin and not process.stdin.closed:
        try:
            if commit:
                process.stdin.write(b"COMMIT\n")
                process.stdin.flush()
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
    line = ""
    if commit:
        line = _line(process)
    try:
        code = process.wait(timeout=120)
    except subprocess.TimeoutExpired as error:
        raise _fail("Offline control helper has an unknown outcome; active lease retained") from error
    if process.stdout:
        process.stdout.close()
    if process.stderr:
        process.stderr.close()
    return line, code


def _run_transaction(context: Mapping[str, Any], args) -> dict[str, Any]:
    plan = context["plan"]
    control = context["control"]
    operation_attempt = plan["operation_attempt"]
    helper_name = "fullmag-control-offline-" + operation_attempt
    from docker_volume_activation_reconcile import _probe_helper_absence
    if _probe_helper_absence(helper_name) is None:
        raise _fail("An earlier offline control helper still exists; its lease remains untouched")
    intent, receipt = _operation_records(plan)
    active_digest = plan["control_pins"].get("active")
    script, preamble = _transaction_script(
        control_root="/control",
        active_token=plan["original_operation_attempt"],
        active_sha256=active_digest,
        pins=plan["control_pins"],
        intent=intent,
        receipt=receipt,
        lock_external=True,
    )
    command = control.helper_args(script, name=helper_name)
    _transaction_mounts(command, store_root=context["store_root"], ledger_volume=context["ledger_volume"])
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT)
    except (OSError, subprocess.SubprocessError) as error:
        raise _fail("Cannot start the isolated offline control helper: " + str(error)) from error
    committed = False
    try:
        if process.stdin is None:
            raise _fail("Offline control helper stdin is unavailable for the bounded proof preamble")
        process.stdin.write(preamble)
        process.stdin.flush()
        _read_locked_helper(process, "LOCKED")
        helper_id = _inspect_transaction_helper(
            control, helper_name, script, context["store_root"], context["ledger_volume"],
        )
        _current_live_plan(context, helper_name, helper_id)
        line, code = _release_helper(process, commit=True)
        committed = True
        if code != 0 or line not in {"COMPLETED", "ALREADY-COMPLETE"}:
            raise _fail("Offline control transaction did not durably complete")
    except BaseException:
        if process.poll() is None:
            try:
                _release_helper(process, commit=False)
            except BaseException:
                pass
        raise
    completed = read_completed(control, operation_attempt)
    if completed is None or completed.get("plan_sha256") != plan["plan_sha256"]:
        raise _fail("Offline repair helper exited without the expected completed proof")
    return completed


def _read_existing_completed_for_apply(args) -> dict[str, Any] | None:
    """Recognize completion or authenticate a publish-before-unlink retry window."""
    try:
        _, _, _, _, control = _select_context(args)
        expected = _attempt(getattr(args, "operation_attempt", None), "offline operation attempt")
        return _read_completed_or_prepared_retry(
            control, expected, getattr(args, "expected_plan_sha256", None),
        )
    except BuildControlError:
        raise


def _require_plan_sha(expected: object, observed: object) -> None:
    if (not isinstance(expected, str) or SHA256_RE.fullmatch(expected) is None
            or not isinstance(observed, str) or SHA256_RE.fullmatch(observed) is None
            or expected != observed):
        raise _fail("Offline repair plan SHA-256 does not match the reviewed plan")


def apply(args) -> dict[str, Any]:
    """Apply only the plan whose digest was explicitly reviewed by the caller."""
    existing = _read_existing_completed_for_apply(args)
    if existing is not None:
        return existing
    context = _collect_context(args)
    plan = context["plan"]
    _require_plan_sha(getattr(args, "expected_plan_sha256", None), plan["plan_sha256"])
    completed = _run_transaction(context, args)
    if completed.get("proof", {}).get("plan_sha256") != plan["plan_sha256"]:
        raise _fail("Completed offline repair is not the reviewed plan")
    return completed


def run(args) -> dict[str, Any]:
    """Convenience dispatcher for callers with the explicit ``apply`` flag."""
    return apply(args) if bool(getattr(args, "apply", False)) else collect(args)
