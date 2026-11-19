"""Quarantine one stopped DEV namespace only when its retained store is empty.

This path never replays the old activation. It writes a pinned intent under
the group's existing locks, removes only the exact stopped backend/frontend
pair, and publishes a fresh namespace after Docker proves both IDs absent.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import time
from collections.abc import Mapping

from docker_build_control import (
    BuildControlError, bounded_capture, canonical, compose_capture,
    control_read_script, docker_capture,
)


SCHEMA = "fullmag.docker-control-namespace-empty-quarantine.v1"
INTENT_SCHEMA = "fullmag.docker-control-namespace-empty-intent.v1"
REGISTRY_SCHEMA = "fullmag.docker-control-namespace-registry.v1"
REGISTRY_PATH = "namespaces/current.json"
SCOPE = "empty-stopped-namespace"
HEX = re.compile(r"[0-9a-f]{32}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
EMPTY_STORE_FILES = frozenset({
    "WRITER.lock",
    "WRITER.owner.json",
    "scheduler_pools/docker-all.compute.resources.json",
    "scheduler_pools/docker-all.preparation.preparation-resources.json",
})
EMPTY_STORE_DIRECTORIES = frozenset({
    "temp", "runs", "scheduler_pools", "live_command_journals", "objects",
    "recovery", "manifests", "runtime-services", "objects/sha256", "objects/pins",
})


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _validate_empty_store_snapshot(snapshot: object) -> dict:
    """Accept the exact technical-only empty store shape, with pinned bytes."""
    if not isinstance(snapshot, dict) or set(snapshot) != {"directories", "files"}:
        _fail("Retained session store snapshot is malformed")
    directories, files = snapshot["directories"], snapshot["files"]
    if (not isinstance(directories, list) or directories != sorted(set(directories))
            or set(directories) != EMPTY_STORE_DIRECTORIES):
        _fail("Retained session store has an unapproved directory")
    if not isinstance(files, dict) or set(files) != EMPTY_STORE_FILES:
        _fail("Retained session store is not empty of accepted runs")
    if any(not isinstance(value, str) or SHA.fullmatch(value) is None
           for value in files.values()):
        _fail("Retained session store file digest is malformed")
    return {"directories": directories, "files": files}


def _validate_empty_ledger(data: object) -> dict:
    if (not isinstance(data, dict) or data.get("schema_version") != "host_resource_ledger.v4"
            or data.get("reservations") != []):
        _fail("Group ledger is not the exact empty v4 ledger")
    return data


def _validate_stopped_container(row: object, *, container_id: str, image_id: str,
                                project: str, service: str) -> dict:
    """Pin one exact Compose container; only a clean stopped state is eligible."""
    if (CONTAINER_ID.fullmatch(container_id or "") is None
            or IMAGE_ID.fullmatch(image_id or "") is None
            or not isinstance(project, str) or not project
            or service not in {"backend", "frontend"}
            or not isinstance(row, dict) or row.get("Id") != container_id):
        _fail("Compose container identity differs from retained evidence")
    state, config = row.get("State"), row.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    host = row.get("HostConfig")
    name = row.get("Name")
    restart_count = row.get("RestartCount")
    if (not isinstance(state, dict) or not isinstance(labels, dict)
            or not isinstance(host, dict)
            or not isinstance(name, str) or not name.strip("/")
            or type(restart_count) is not int or restart_count != 0
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service
            or row.get("Image") != image_id
            or state.get("Running") is not False or state.get("Pid") != 0
            or state.get("Status") != "exited" or state.get("ExitCode") != 255
            or state.get("Restarting") is not False or state.get("Paused") is not False
            or state.get("Dead") is not False
            or state.get("OOMKilled") is not False
            or host.get("PidMode") not in (None, "")
            or host.get("Privileged") is not False
            or not isinstance(state.get("StartedAt"), str) or not state["StartedAt"]
            or not isinstance(state.get("FinishedAt"), str) or not state["FinishedAt"]):
        _fail("Only the exact private-PID stopped Compose pair may be quarantined")
    return {
        "id": container_id,
        "name": name.lstrip("/"),
        "image_id": image_id,
        "project": project,
        "service": service,
        "started_at": state.get("StartedAt"),
        "finished_at": state.get("FinishedAt"),
        "exit_code": 255,
        "oom_killed": False,
        "pid": 0,
        "restart_count": restart_count,
        "network_names": sorted((row.get("NetworkSettings", {}).get("Networks") or {}).keys()),
        "inspect_sha256": _sha256(canonical(row)),
    }


def _validate_empty_namespace_receipt(receipt: object, *, namespace: str,
                                       project: str, volume: str,
                                       worktree_id: str, project_id: str) -> bool:
    return (
        isinstance(receipt, dict)
        and receipt.get("schema") == SCHEMA
        and receipt.get("state") == "quarantined-empty-not-replayed"
        and receipt.get("scope") == SCOPE
        and receipt.get("namespace") == namespace
        and receipt.get("compose_project") == project
        and receipt.get("control_volume") == volume
        and receipt.get("source_worktree_id") == worktree_id
        and receipt.get("source_project_id") == project_id
        and receipt.get("allow_new_requests") is True
        and receipt.get("allow_old_request_replay") is False
        and isinstance(receipt.get("old_request_id"), str)
        and bool(receipt.get("old_request_id"))
        and HEX.fullmatch(receipt.get("recovery_id", "")) is not None
        and namespace == "namespaces/" + receipt.get("recovery_id", "")
    )


def _read_control_raw(control, relative: str, *, optional: bool = False) -> bytes | None:
    result = bounded_capture(control.helper_args(control_read_script(control.path(relative))),
                             data=b"", timeout=60)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        _fail("Cannot authenticate control record: " + relative)
    return result.stdout


def _read_control_json(control, relative: str, *, optional: bool = False):
    raw = _read_control_raw(control, relative, optional=optional)
    return None if raw is None else json.loads(raw)


def _json_object(raw: bytes, label: str) -> dict:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                _fail(label + " has duplicate JSON keys")
            result[key] = value
        return result
    value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=unique)
    if not isinstance(value, dict):
        _fail(label + " must be a JSON object")
    return value


def _regular_file_sha(path: Path) -> str:
    try:
        before = path.lstat()
    except OSError as error:
        raise BuildControlError("Cannot inspect retained store file: " + str(path)) from error
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_size > 8 * 1024 * 1024):
        _fail("Retained store contains a non-regular or unbounded file")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        if (opened.st_ino, opened.st_dev, opened.st_size) != (
                before.st_ino, before.st_dev, before.st_size):
            _fail("Retained store file changed during inspection")
        digest = hashlib.sha256()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            digest.update(block)
        after = os.fstat(fd)
        if (opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
                after.st_ino, after.st_size, after.st_mtime_ns):
            _fail("Retained store file changed while hashing")
        return digest.hexdigest()
    finally:
        os.close(fd)


def _empty_store_snapshot(root: Path) -> dict:
    if root.is_symlink() or not root.is_dir() or root.resolve(strict=True) != root:
        _fail("Retained session store root is linked or missing")
    directories: set[str] = set()
    files: dict[str, str] = {}
    for parent, dirnames, filenames in os.walk(root, followlinks=False):
        parent_path = Path(parent)
        for name in list(dirnames):
            child = parent_path / name
            if child.is_symlink() or not child.is_dir():
                _fail("Retained store contains a linked or non-directory entry")
            rel = child.relative_to(root).as_posix()
            directories.add(rel)
        for name in filenames:
            child = parent_path / name
            rel = child.relative_to(root).as_posix()
            if rel not in EMPTY_STORE_FILES:
                _fail("Retained session store contains accepted-run or unexpected data: " + rel)
            files[rel] = _regular_file_sha(child)
        if len(files) > len(EMPTY_STORE_FILES) or len(directories) > len(EMPTY_STORE_DIRECTORIES):
            _fail("Retained session store exceeds the bounded empty-store shape")
    snapshot = _validate_empty_store_snapshot({
        "directories": sorted(directories), "files": files,
    })
    owner = _json_object((root / "WRITER.owner.json").read_bytes(), "session-store writer owner")
    if owner.get("schema") != "fullmag.writer.v1" or owner.get("released") is not True:
        _fail("Retained session-store writer owner is not released")
    return snapshot


def _single_compose_id(document: dict, service: str) -> str:
    output = compose_capture(document, "ps", "--all", "--quiet", service)
    ids = [line.strip() for line in output.decode("utf-8", "strict").splitlines()
           if line.strip()]
    if len(ids) != 1 or CONTAINER_ID.fullmatch(ids[0]) is None:
        _fail("Retained Compose does not identify exactly one " + service + " container")
    return ids[0]


def _read_pair(document: dict, identity: dict, control, terminal: dict) -> tuple[dict, dict]:
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _assert_private_restart_network, _validate_retained_service

    services = document.get("services")
    if not isinstance(services, Mapping) or set(services) != {"backend", "frontend"}:
        _fail("Retained Compose must contain exactly the backend/frontend pair")
    expected_ids = {
        "backend": terminal.get("backend_container"),
        "frontend": terminal.get("frontend_container"),
    }
    actual_ids = {service: _single_compose_id(document, service) for service in expected_ids}
    if (any(not isinstance(value, str) or CONTAINER_ID.fullmatch(value) is None
            for value in expected_ids.values()) or actual_ids != expected_ids):
        _fail("Compose service IDs differ from the successful development receipt")
    rows = json.loads(docker_capture("inspect", *actual_ids.values()).stdout)
    by_id = {row.get("Id"): row for row in rows if isinstance(row, dict)}
    if set(by_id) != set(actual_ids.values()):
        _fail("Retained backend/frontend inspection is incomplete")
    evidence = {}
    for service, identifier in actual_ids.items():
        row = by_id[identifier]
        config = row.get("Config", {})
        labels = config.get("Labels") if isinstance(config, dict) else None
        image_ref = services[service].get("image")
        if not isinstance(image_ref, str) or not image_ref:
            _fail("Retained Compose has no immutable " + service + " image reference")
        image_rows = json.loads(docker_capture("image", "inspect", image_ref).stdout)
        if len(image_rows) != 1 or not isinstance(image_rows[0].get("Config"), Mapping):
            _fail("Retained " + service + " image inspection is incomplete")
        image_id = image_rows[0].get("Id")
        if IMAGE_ID.fullmatch(image_id or "") is None:
            _fail("Retained " + service + " image identity is not immutable")
        if (row.get("Image") != image_id or not isinstance(labels, dict)
                or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != service):
            _fail("Retained " + service + " container source/image labels differ")
        validate_source_labels(row, identity)
        _validate_retained_service(document, row, service, image_rows[0]["Config"],
                                   expected_started_at=(terminal.get("backend_started_at")
                                                        if service == "backend" else None))
        if service == "backend" and terminal.get("image_id") not in (None, image_id):
            _fail("Retained backend image differs from the successful development receipt")
        evidence[service] = _validate_stopped_container(
            row, container_id=identifier, image_id=image_id,
            project=control.project, service=service,
        )
    actual = {service: by_id[identifier] for service, identifier in actual_ids.items()}
    _assert_private_restart_network(actual, actual_ids, control.project)
    backend_networks = actual["backend"].get("NetworkSettings", {}).get("Networks", {})
    frontend_networks = actual["frontend"].get("NetworkSettings", {}).get("Networks", {})
    if (not isinstance(backend_networks, Mapping) or not isinstance(frontend_networks, Mapping)
            or (frontend_networks and set(backend_networks) != set(frontend_networks))):
        _fail("Retained stopped pair does not share its pinned private application network")
    return evidence, by_id


def _project_inventory(control, pair: Mapping[str, Mapping[str, object]], *,
                       protected_volumes: set[str], state_root: Path, ledger_volume: str,
                       helper_name: str | None = None, state_sources=(),
                       shared_consumer_validator=None) -> list[str]:
    def overlaps(left: str, right: str) -> bool:
        left, right = left.rstrip("/"), right.rstrip("/")
        return left == right or left.startswith(right + "/") or right.startswith(left + "/")

    ids = docker_capture("ps", "-aq", "--no-trunc").stdout.decode("utf-8", "strict").splitlines()
    ids = [value.strip() for value in ids if value.strip()]
    if len(ids) > 256 or any(CONTAINER_ID.fullmatch(value) is None for value in ids):
        _fail("Docker container inventory is incomplete or exceeds its bound")
    rows = json.loads(docker_capture("inspect", *ids).stdout) if ids else []
    if not isinstance(rows, list) or len(rows) != len(ids):
        _fail("Docker container inventory inspection is incomplete")
    allowed = {evidence["id"] for evidence in pair.values()}
    selected_project_ids = set()
    for row in rows:
        if not isinstance(row, dict):
            _fail("Docker container inventory contains malformed data")
        labels = row.get("Config", {}).get("Labels") or {}
        is_project = (labels.get("com.docker.compose.project") == control.project
                      or labels.get("org.fullmag.compose.project") == control.project)
        identifier = row.get("Id")
        if is_project:
            selected_project_ids.add(identifier)
            if helper_name and row.get("Name", "").lstrip("/") == helper_name:
                continue
            if identifier not in allowed:
                _fail("Selected Compose project has another container: " + str(identifier))
        if identifier in allowed:
            continue
        if shared_consumer_validator is not None:
            shared_consumer_validator(row)
        for mount in [*row.get("Mounts", []), *row.get("HostConfig", {}).get("Mounts", [])]:
            source = str(mount.get("Source", "")).replace("\\", "/")
            targets = [str(state_root), *state_sources]
            if (mount.get("Name") in protected_volumes
                    or (source and any(overlaps(source, str(target).replace("\\", "/")) for target in targets))
                    or (source and overlaps(source, str(ledger_volume)))):
                _fail("A protected state, control, cache or ledger volume has another consumer")
    if selected_project_ids - allowed - ({
            row.get("Id") for row in rows
            if helper_name and row.get("Name", "").lstrip("/") == helper_name
    } if helper_name else set()):
        _fail("Selected Compose project inventory contains an unapproved container")
    return sorted(ids)


def _network_inventory(project: str, network_names: list[str], allowed_ids: set[str]) -> str:
    if (not isinstance(network_names, list) or len(network_names) != 1
            or not isinstance(network_names[0], str) or not network_names[0]):
        _fail("Stopped backend/frontend pair has no single shared private network")
    rows = json.loads(docker_capture("network", "inspect", network_names[0]).stdout)
    if len(rows) != 1 or not isinstance(rows[0], dict):
        _fail("Retained private network inspection is incomplete")
    row = rows[0]
    consumers = set((row.get("Containers") or {}).keys())
    if (row.get("Name") != network_names[0] or CONTAINER_ID.fullmatch(row.get("Id", "")) is None
            or row.get("Driver") != "bridge"
            or (row.get("Labels") or {}).get("com.docker.compose.project") != project
            or consumers - allowed_ids):
        _fail("Retained private network has a foreign consumer or identity")
    return _sha256(canonical({
        "network": network_names[0], "network_id": row["Id"], "driver": row.get("Driver"),
        "labels": row.get("Labels") or {}, "foreign_consumers": sorted(consumers - allowed_ids),
    }))


def _group_ledger_mount(compose: dict, project: str) -> tuple[str, str]:
    import docker_group_ledger as group_ledger

    backend = compose.get("services", {}).get("backend", {})
    mounts = [item for item in backend.get("volumes", [])
              if isinstance(item, Mapping) and item.get("target") == group_ledger.MOUNT_TARGET]
    volumes = compose.get("volumes", {})
    configured = volumes.get(group_ledger.COMPOSE_VOLUME) if isinstance(volumes, Mapping) else None
    if (len(mounts) != 1 or mounts[0].get("type") != "volume"
            or mounts[0].get("source") != group_ledger.COMPOSE_VOLUME
            or not isinstance(configured, Mapping) or configured.get("external") is not True
            or not isinstance(configured.get("name"), str)
            or not configured["name"].startswith(group_ledger.VOLUME_PREFIX)
            or not group_ledger.is_group_ledger_backend(backend.get("environment", {}))):
        _fail("Retained successful attempt has no exact isolated group ledger volume")
    name = configured["name"]
    return name, "type=volume,src=" + name + ",dst=/ledger,readonly,volume-nocopy"


def _read_group_ledger(control, mount: str) -> tuple[dict, str]:
    command = control.helper_args("head -c 8388608 /ledger/ledger/HOST_RESOURCE_LEDGER.json")
    index = command.index("--entrypoint")
    command[index:index] = ["--mount", mount]
    result = bounded_capture(command, data=b"", timeout=60)
    if result.returncode:
        _fail("Cannot read the exact retained group ledger")
    ledger = _validate_empty_ledger(_json_object(result.stdout, "retained group ledger"))
    return ledger, _sha256(result.stdout)


def _collect_evidence(args) -> dict:
    import fullmag_storage as storage
    from docker_dev_up import _selected_context

    _, selected, layout, identity, control = _selected_context(args)
    if control.namespace:
        _fail("A namespace is already selected; inspect its immutable receipt")
    if HEX.fullmatch(args.activation) is None or HEX.fullmatch(args.recovery_id) is None:
        _fail("Recovery and activation identities must be 32 lowercase hexadecimal characters")
    if _read_control_raw(control, REGISTRY_PATH, optional=True) is not None:
        _fail("A namespace registry already exists for this group")

    active_raw = _read_control_raw(control, "active")
    if active_raw.decode("utf-8", "strict").strip() != args.activation:
        _fail("Recovery does not bind the current active lease")
    activation_path = "activation/attempts/" + args.activation + "/receipt.json"
    activation = _json_object(_read_control_raw(control, activation_path), "unknown activation receipt")
    if (activation.get("schema") != "fullmag.docker-build-operation.v1"
            or activation.get("phase") != "activation"
            or activation.get("attempt") != args.activation
            or activation.get("state") != "outcome-unknown-resources-retained"
            or activation.get("compose_project") != control.project
            or activation.get("control_volume") != control.volume
            or activation.get("helper_container") != "fullmag-control-" + args.activation):
        _fail("Only the exact retained unknown activation is eligible")
    if _read_control_raw(control, "activation/attempts/" + args.activation + "/terminal.json",
                         optional=True) is not None:
        _fail("Original activation already has a terminal outcome")
    inputs = activation.get("inputs")
    if not isinstance(inputs, Mapping):
        _fail("Unknown activation has no immutable inputs")
    development = inputs.get("development_attempt")
    if not isinstance(development, str) or HEX.fullmatch(development) is None:
        _fail("Unknown activation has no valid retained development attempt")
    config_sha = activation.get("config_sha256")
    if SHA.fullmatch(config_sha or "") is None or inputs.get("config_sha256") != config_sha:
        _fail("Unknown activation has no exact retained Compose configuration pin")
    development_root = "development/attempts/" + development
    terminal_raw = _read_control_raw(control, development_root + "/terminal.json")
    compose_raw = _read_control_raw(control, development_root + "/compose.json")
    terminal = _json_object(terminal_raw, "successful development terminal")
    compose = _json_object(compose_raw, "retained Compose configuration")
    if (terminal.get("schema") != "fullmag.docker-build-operation.v1"
            or terminal.get("phase") != "development" or terminal.get("state") != "succeeded"
            or terminal.get("attempt") != development
            or terminal.get("compose_project") != control.project
            or terminal.get("inputs", {}).get("source_root") != str(selected)
            or activation.get("source_root") != str(selected)
            or activation.get("development_attempt") not in (None, development)
            or compose.get("name") != control.project
            or _sha256(canonical(compose)) != config_sha
            or terminal.get("config_sha256") not in (None, config_sha)):
        _fail("Retained successful attempt/source/configuration pins differ")
    pins, raw_records = _pinned_control_records(control, args.activation, activation, development)
    from docker_volume_activation_reconcile import _probe_helper_absence
    helper_name = "fullmag-control-" + args.activation
    helper_absence_sha = _probe_helper_absence(helper_name)
    if helper_absence_sha is None:
        _fail("Original activation helper still exists")

    state = storage.validate_path(Path(terminal["state_root"]), layout["runtime_root"],
                                  "retained state root")
    store = state / "runs/docker-all/session-store"
    store_snapshot = _empty_store_snapshot(store)
    if any(str(root).casefold().endswith("/runs") for root, _, _ in os.walk(store / "runs")):
        # Empty run containers are allowed only as a parent; no run directory
        # or RunIntent can be hidden below the approved root.
        if any((store / "runs").iterdir()):
            _fail("Retained session store has a run directory or RunIntent")

    ledger_volume, ledger_mount = _group_ledger_mount(compose, control.project)
    ledger, ledger_sha = _read_group_ledger(control, ledger_mount)
    ledger_reservations = ledger["reservations"]
    if ledger_reservations != []:
        _fail("Group ledger contains reservations")
    engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode("utf-8", "strict").strip()
    if not engine:
        _fail("Docker daemon identity is unavailable")
    toolchain = _read_control_json(control, "toolchain/verified.json")
    helper_image = toolchain.get("image_id") if isinstance(toolchain, dict) else None
    if (not isinstance(toolchain, dict) or toolchain.get("state") != "succeeded"
            or IMAGE_ID.fullmatch(helper_image or "") is None):
        _fail("Recovery requires the retained verified immutable helper toolchain")

    pair, rows = _read_pair(compose, identity, control, terminal)
    if (pair["backend"]["started_at"] != terminal.get("backend_started_at")
            or any(item["restart_count"] != 0 for item in pair.values())
            or pair["backend"]["network_names"] != pair["frontend"]["network_names"]):
        _fail("Stopped service pair does not match its original non-restarted incarnation")
    network_sha = _network_inventory(
        control.project, pair["backend"]["network_names"],
        {item["id"] for item in pair.values()},
    )
    protected = {control.volume, ledger_volume}
    if isinstance(terminal.get("backend_volumes"), Mapping):
        protected.update(value for value in terminal["backend_volumes"].values()
                         if isinstance(value, str))
    for item in compose.get("volumes", {}).values():
        if isinstance(item, Mapping) and isinstance(item.get("name"), str):
            protected.add(item["name"])
    state_sources = sorted({str(state), *[
        mount["Source"] for row in rows.values()
        for mount in [*row.get("Mounts", []), *row.get("HostConfig", {}).get("Mounts", [])]
        if mount.get("Type", mount.get("type")) == "bind"
        and mount.get("Destination", mount.get("Target")) == "/state"
        and isinstance(mount.get("Source"), str)
    ]})
    _project_inventory(control, pair, protected_volumes=protected,
                       state_root=state, ledger_volume=ledger_volume, state_sources=state_sources)
    request_id = activation.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        _fail("Unknown activation has no original request identity")
    activation_inputs = activation.get("inputs", {})
    if activation_inputs.get("request_id") != request_id:
        _fail("Activation request identity differs from its immutable inputs")
    marker_path = activation_inputs.get("activation_receipt_path")
    marker_key = activation_inputs.get("activation_receipt_key")
    if (not isinstance(marker_path, str) or not marker_path.startswith("/opt/fullmag/control/")
            or marker_key != _sha256(request_id.encode("utf-8"))):
        _fail("Activation marker is not bound to the original request")
    marker_relative = marker_path.removeprefix("/opt/fullmag/control/")
    record = {
        "schema": INTENT_SCHEMA,
        "state": "removal-authorized",
        "scope": SCOPE,
        "recovery_id": args.recovery_id,
        "namespace": "namespaces/" + args.recovery_id,
        "compose_project": control.project,
        "control_volume": control.volume,
        "source_root": str(selected),
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "old_activation_attempt": args.activation,
        "old_request_id": request_id,
        "old_activation_outcome": "unknown-retained",
        "activation_receipt_path": activation_path,
        "activation_marker_path": marker_relative,
        "development_attempt": development,
        "development_terminal_path": development_root + "/terminal.json",
        "development_compose_path": development_root + "/compose.json",
        "config_sha256": config_sha,
        "control_pins": pins,
        "activation_marker_sha256": pins[marker_relative],
        "helper_absence_sha256": helper_absence_sha,
        "stopped_pair": pair,
        "network_sha256": network_sha,
        "retained_store_snapshot": store_snapshot,
        "retained_state_root": str(state),
        "ledger_volume": ledger_volume,
        "ledger_sha256": ledger_sha,
        "empty_reservation_count": len(ledger_reservations),
        "docker_engine_id": engine,
        "verified_helper_image_id": helper_image,
        "protected_volumes": sorted(protected),
        "protected_state_sources": state_sources,
        "allow_new_requests": True,
        "allow_old_request_replay": False,
        "authorization": "explicit-user-recovery-and-new-start",
        "created_at": time.time(),
    }
    # Metadata fields used by the resolver are explicit and immutable.
    return {"record": record, "store_root": str(store), "ledger_mount": ledger_mount,
            "terminal": terminal, "compose": compose, "identity": identity,
            "layout": layout, "selected": selected, "control": control}


def _pinned_control_records(control, activation_id: str, activation: dict,
                            development_attempt: str) -> tuple[dict[str, str], dict[str, bytes]]:
    activation_path = "activation/attempts/" + activation_id + "/receipt.json"
    development_root = "development/attempts/" + development_attempt
    inputs = activation.get("inputs")
    request_id = activation.get("request_id")
    if not isinstance(inputs, Mapping) or not isinstance(request_id, str) or not request_id:
        _fail("Original activation has no exact request inputs")
    marker_key = _sha256(request_id.encode("utf-8"))
    marker_path = "backend/script-activation-" + marker_key + "/activation.json"
    if (inputs.get("request_id") != request_id
            or inputs.get("activation_receipt_key") != marker_key
            or inputs.get("activation_receipt_path") != "/opt/fullmag/control/" + marker_path):
        _fail("Original activation marker path does not bind its request")
    paths = [
        "active", activation_path, marker_path,
        development_root + "/terminal.json", development_root + "/compose.json",
        "runtime-control/runtime-services/OWNER.json",
        "runtime-control/runtime-services/LAUNCH.json",
        "runtime-control/runtime-service/process-tree.json",
    ]
    raw_records = {}
    for path in paths:
        raw_records[path] = _read_control_raw(control, path)
    pins = {path: _sha256(raw) for path, raw in raw_records.items()}
    if raw_records["active"].decode("utf-8", "strict").strip() != activation_id:
        _fail("Recovery does not bind the current activation")
    marker = json.loads(raw_records[marker_path])
    if (not isinstance(marker, dict)
            or marker.get("schema") != "fullmag.docker-startup-activation-receipt.v1"
            or marker.get("state") != "started" or marker.get("request_id") != request_id
            or marker.get("source_sha256") != inputs.get("source_sha256")
            or marker.get("provenance_sha256") != inputs.get("provenance_sha256")
            or not isinstance(marker.get("authorization"), Mapping)
            or marker["authorization"].get("request_id") != request_id
            or marker["authorization"].get("source_sha256") != inputs.get("source_sha256")):
        _fail("Original activation marker is not the exact still-started request")
    owner = json.loads(raw_records["runtime-control/runtime-services/OWNER.json"])
    tree = json.loads(raw_records["runtime-control/runtime-service/process-tree.json"])
    from docker_volume_stop_failed import _owner_identity_key, _validate_native_ready_owner
    ready_owner = _validate_native_ready_owner(owner)
    process_owner = tree.get("service_owner") if isinstance(tree, dict) else None
    if (not isinstance(tree, dict) or tree.get("schema") != "fullmag.docker-process-tree.v1"
            or tree.get("state") != "ready"
            or _owner_identity_key(process_owner, "ready process-tree owner")
            != _owner_identity_key(ready_owner, "ready OWNER.json")):
        _fail("Ready native owner and process-tree bindings differ")
    return pins, raw_records



def _validate_intent(record, args, control, selected):
    """Validate an immutable removal intent without assuming containers survive."""
    if (not isinstance(record, dict) or record.get("schema") != INTENT_SCHEMA
            or record.get("state") != "removal-authorized" or record.get("scope") != SCOPE
            or record.get("recovery_id") != args.recovery_id
            or record.get("old_activation_attempt") != args.activation
            or record.get("namespace") != "namespaces/" + args.recovery_id
            or record.get("compose_project") != control.project
            or record.get("control_volume") != control.volume
            or record.get("source_root") != str(selected)
            or record.get("source_project_id") != control.identity["project_id"]
            or record.get("source_worktree_id") != control.identity["worktree_id"]
            or record.get("old_activation_outcome") != "unknown-retained"
            or record.get("allow_old_request_replay") is not False
            or record.get("allow_new_requests") is not True
            or record.get("empty_reservation_count") != 0):
        _fail("Existing removal intent does not bind this exact recovery")
    pair = record.get("stopped_pair")
    if not isinstance(pair, dict) or set(pair) != {"backend", "frontend"}:
        _fail("Removal intent has no exact stopped pair")
    for service, item in pair.items():
        if (not isinstance(item, dict) or item.get("service") != service
                or item.get("project") != control.project
                or item.get("name") != control.project + "-" + service + "-1"
                or CONTAINER_ID.fullmatch(item.get("id", "")) is None
                or IMAGE_ID.fullmatch(item.get("image_id", "")) is None
                or SHA.fullmatch(item.get("inspect_sha256", "")) is None
                or item.get("pid") != 0 or item.get("exit_code") != 255
                or item.get("restart_count") != 0):
            _fail("Removal intent has invalid stopped-container pins")
    if pair["backend"]["id"] == pair["frontend"]["id"]:
        _fail("Removal intent repeats a container")
    if (not isinstance(record.get("ledger_volume"), str)
            or not record["ledger_volume"].startswith("fullmag-dev-group-ledger-v1-")
            or SHA.fullmatch(record.get("ledger_sha256", "")) is None
            or IMAGE_ID.fullmatch(record.get("verified_helper_image_id", "")) is None
            or not isinstance(record.get("protected_volumes"), list)
            or not {control.volume, record["ledger_volume"]}.issubset(record["protected_volumes"])):
        _fail("Removal intent has invalid volume or image pins")
    state_sources = record.get("protected_state_sources")
    if (not isinstance(state_sources, list) or not state_sources
            or any(not isinstance(value, str) or not value or len(value) > 4096 for value in state_sources)
            or record.get("retained_state_root") not in state_sources):
        _fail("Removal intent has no protected state bind aliases")
    _validate_empty_store_snapshot(record.get("retained_store_snapshot"))
    from docker_control_namespace import _validate_empty_stopped_control_pins
    _validate_empty_stopped_control_pins(control, record)
    terminal = _read_control_json(control, record["development_terminal_path"])
    if (terminal.get("state") != "succeeded"
            or terminal.get("state_root") != record.get("retained_state_root")
            or terminal.get("backend_container") != pair["backend"]["id"]
            or terminal.get("frontend_container") != pair["frontend"]["id"]):
        _fail("Removal intent differs from the pinned successful development")


def _pair_presence(record):
    """Return surviving exact IDs; missing IDs require independent name absence."""
    from docker_volume_activation_reconcile import _probe_helper_absence
    from docker_volume_fresh_runtime import _assert_exact_absence
    present = []
    for service, item in record["stopped_pair"].items():
        result = docker_capture("inspect", item["id"], allow_failure=True, timeout=60)
        if result.returncode:
            _assert_exact_absence(item["id"], service)
            if _probe_helper_absence(item["name"]) is None:
                _fail("A stopped service name has been reused by another container")
            continue
        rows = json.loads(result.stdout)
        if len(rows) != 1 or _sha256(canonical(rows[0])) != item["inspect_sha256"]:
            _fail("Stopped container incarnation changed after intent publication")
        present.append(item["id"])
    return present


def _revalidate_external(record, control, helper_name=None):
    from docker_volume_activation_reconcile import _probe_helper_absence
    if _probe_helper_absence("fullmag-control-" + record["old_activation_attempt"]) is None:
        _fail("Original activation helper is no longer absent")
    engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    if engine != record["docker_engine_id"]:
        _fail("Docker daemon changed during recovery")
    names = record["stopped_pair"]["backend"]["network_names"]
    ids = {item["id"] for item in record["stopped_pair"].values()}
    if _network_inventory(control.project, names, ids) != record["network_sha256"]:
        _fail("Private network changed during recovery")
    _project_inventory(control, record["stopped_pair"],
        protected_volumes=set(record["protected_volumes"]),
        state_root=Path(record["retained_state_root"]),
        ledger_volume=record["ledger_volume"], helper_name=helper_name,
        state_sources=record.get("protected_state_sources", ()))
    return _pair_presence(record)


def _transaction_script():
    """Extend the existing locked namespace publisher with a durable removal intent."""
    from docker_control_namespace import COMMIT
    anchor = "verify()\nprint('LOCKED',flush=True)\n"
    if COMMIT.count(anchor) != 1:
        _fail("Existing namespace publisher protocol changed")
    prefix, rest = COMMIT.split(anchor)
    handshake, rest = rest.split("def directory(p):\n", 1)
    definitions, publication = ("def directory(p):\n" + rest).split(
        "for rel in ['namespace-recovery'", 1)
    prefix = prefix.replace("record=payload['record'];", "record=payload['record']; intent=payload['intent'];")
    prefix = prefix.replace("if any(v.get('state')!='released' for v in reservations):",
        "if data.get('schema_version')!='host_resource_ledger.v4' or data.get('reservations')!=[]:")
    prefix = prefix.replace("actual={}\n", "actual={}\n    actual_dirs=[]\n")
    prefix = prefix.replace("for name in files:\n", "for d in dirs: actual_dirs.append((P(parent)/d).relative_to('/retained').as_posix())\n        for name in files:\n")
    prefix = prefix.replace("if actual!=record['store_snapshot']:",
        "if actual!=record['retained_store_snapshot']['files'] or sorted(actual_dirs)!=record['retained_store_snapshot']['directories']:")
    preparation = """
verify()
for rel in ['namespace-recovery','namespace-recovery/'+record['recovery_id']]: directory(root/rel)
intent_data=(json.dumps(intent,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\\n').encode()
if hashlib.sha256(intent_data).hexdigest()!=record['intent_sha256']: raise RuntimeError('intent digest differs')
publish(root/record['intent_path'],intent_data)
print('LOCKED',flush=True)
"""
    return prefix + definitions + preparation + handshake + "for rel in ['namespace-recovery'" + publication


def _apply_transaction(proof):
    record, control = proof["record"], proof["control"]
    intent_path = "namespace-recovery/" + record["recovery_id"] + "/intent.json"
    final = {**record, "schema": SCHEMA, "state": "quarantined-empty-not-replayed",
             "intent_path": intent_path, "intent_sha256": _sha256(canonical(record) + b"\n")}
    helper_name = "fullmag-empty-quarantine-" + record["recovery_id"]
    from docker_volume_activation_reconcile import _probe_helper_absence
    if _probe_helper_absence(helper_name) is None:
        _fail("An existing recovery helper must be observed, not repeated")
    command = control.helper_args("exec python3 -I -B -c " + shlex.quote(_transaction_script()), name=helper_name)
    command[command.index(control.image)] = record["verified_helper_image_id"]
    index = command.index("--entrypoint")
    command[index:index] = ["--mount", proof["ledger_mount"],
        "--mount", "type=bind,src=" + proof["store_root"] + ",dst=/retained,readonly"]
    payload = canonical({"record": final, "intent": record}) + b"\n"
    if len(payload) > 1024 * 1024:
        _fail("Recovery intent exceeds the helper protocol budget")
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write(payload)
        process.stdin.flush()
        if control._line(process) != "LOCKED":
            _fail("Empty recovery helper did not publish its intent under all locks")
        # The helper holds the store/ledger/native/global locks for all Docker
        # observations and exact-ID removals. No lease/owner record is rewritten.
        surviving = _revalidate_external(record, control, helper_name)
        for identifier in surviving:
            if identifier not in _pair_presence(record):
                _fail("Container disappeared at its removal boundary")
            docker_capture("rm", identifier, timeout=90)
        if _revalidate_external(record, control, helper_name):
            _fail("Recovery still has a surviving old container")
        process.stdin.write(b"COMMIT\n")
        process.stdin.flush()
        process.stdin.close()
        output = control._line(process)
        if process.wait(timeout=90) != 0:
            _fail("Namespace publication did not finish; keep the intent and inspect its outcome")
        result = json.loads(output)
        if result.get("state") != final["state"] or result.get("namespace") != final["namespace"]:
            _fail("Namespace publication returned another outcome")
        return result
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass  # Unknown commit outcome retains the helper and all evidence.
        if process.poll() is not None and process.stderr:
            diagnostic = process.stderr.read(8192).decode("utf-8", "replace")
            if diagnostic:
                print(diagnostic, file=sys.stderr)


def quarantine(args):
    """Dry-run or explicitly quarantine a proven empty stopped namespace."""
    from docker_dev_up import _selected_context
    import fullmag_storage as storage
    _, selected, layout, _, control = _selected_context(args)
    if HEX.fullmatch(args.activation) is None or HEX.fullmatch(args.recovery_id) is None:
        _fail("Invalid recovery or activation identity")
    if control.namespace:
        retirement = control.namespace_registry["retirement"]
        if (retirement.get("schema") == SCHEMA and retirement.get("recovery_id") == args.recovery_id
                and retirement.get("old_activation_attempt") == args.activation):
            result = {"state": "already-quarantined", "namespace": control.namespace}
            print(json.dumps(result))
            return result
        _fail("A different namespace has already been selected")
    intent_path = "namespace-recovery/" + args.recovery_id + "/intent.json"
    raw = _read_control_raw(control, intent_path, optional=True)
    if raw is None:
        proof = _collect_evidence(args)
    else:
        record = _json_object(raw, "retained removal intent")
        if raw != canonical(record) + b"\n":
            _fail("Removal intent is not canonical immutable evidence")
        _validate_intent(record, args, control, selected)
        state = storage.validate_path(Path(record["retained_state_root"]), layout["runtime_root"], "retained state")
        store = state / "runs/docker-all/session-store"
        if _empty_store_snapshot(store) != record["retained_store_snapshot"]:
            _fail("Retained empty store changed after intent publication")
        ledger_mount = "type=volume,src=" + record["ledger_volume"] + ",dst=/ledger,readonly,volume-nocopy"
        _, ledger_sha = _read_group_ledger(control, ledger_mount)
        if ledger_sha != record["ledger_sha256"]:
            _fail("Retained ledger changed after intent publication")
        _revalidate_external(record, control)
        proof = {"record": record, "control": control, "store_root": str(store), "ledger_mount": ledger_mount}
    if args.apply:
        result = _apply_transaction(proof)
    else:
        record = proof["record"]
        result = {"state": "eligible-no-mutation", "recovery_id": record["recovery_id"],
                  "namespace": record["namespace"], "project": control.project,
                  "backend_container": record["stopped_pair"]["backend"]["id"],
                  "frontend_container": record["stopped_pair"]["frontend"]["id"],
                  "store_files": sorted(record["retained_store_snapshot"]["files"]),
                  "ledger_volume": record["ledger_volume"], "ledger_sha256": record["ledger_sha256"]}
    print(json.dumps(result, sort_keys=True, indent=2))
    return result
