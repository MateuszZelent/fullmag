"""Fixed Docker named-volume contract for frontend development."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
from typing import Any, Callable, Mapping

from docker_compose_identity import compose_project_identity

SCHEMA = "fullmag.frontend-development-volume.v1"
OWNER_SCHEMA = "fullmag.frontend-development-owner.v1"
ROLE = "frontend-development"
PROFILE = "dev"
MAINTENANCE_PROFILE = "frontend-volume-maintenance-v1"
MAINTENANCE_SERVICE = "frontend-development-volume-maintenance"
MAINTENANCE_COMPOSE = "compose.frontend-volume-maintenance.json"
MAINTENANCE_PIDS_LIMIT = 16
MAINTENANCE_MEMORY_LIMIT = "128m"
MAINTENANCE_CPUS = 0.25
ENTRYPOINT = ["/usr/local/bin/python3", "/opt/fullmag/frontend_volume_maintenance.py"]
VOLUME_TARGET = "/state/development"
SOURCE_TARGET = "/run/fullmag/source"
CONTROL_TARGET = "/run/fullmag/control"
HELPER_TARGET = "/opt/fullmag/frontend_volume_maintenance.py"
UID = 65532
GID = 65532
PREFIX = "com.fullmag.frontend-development."
LABELS = {
    "schema": PREFIX + "schema",
    "project": PREFIX + "project-id",
    "worktree": PREFIX + "worktree-id",
    "toolchain": PREFIX + "toolchain-image-id",
    "profile": PREFIX + "profile",
    "role": PREFIX + "role",
    "owner": PREFIX + "owner-id",
    "creation": PREFIX + "creation-id",
    "compose": PREFIX + "compose-project",
}
_IMAGE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_NONCE = re.compile(r"^[0-9a-f]{32}$")


class FrontendVolumeError(RuntimeError):
    pass


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _source(value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.is_symlink():
        raise FrontendVolumeError("source_root must be an absolute real checkout")
    try:
        path = path.resolve(strict=True)
    except OSError as error:
        raise FrontendVolumeError("source checkout is unavailable") from error
    if not path.is_dir() or path.is_symlink():
        raise FrontendVolumeError("source_root must be a real directory")
    return path


def _identity(project_id: str, worktree_id: str, image: str, profile: str) -> dict[str, str]:
    seed = {"schema": SCHEMA, "project_id": project_id, "worktree_id": worktree_id,
            "toolchain_image_id": image, "profile": profile, "role": ROLE}
    owner = hashlib.sha256(_canonical(seed)).hexdigest()
    return {**seed, "owner_id": owner, "volume_name": "fullmag-frontend-dev-v1-" + owner[:32]}


def _base_labels(identity: Mapping[str, str]) -> dict[str, str]:
    return {
        LABELS["schema"]: identity["schema"],
        LABELS["project"]: identity["project_id"],
        LABELS["worktree"]: identity["worktree_id"],
        LABELS["toolchain"]: identity["toolchain_image_id"],
        LABELS["profile"]: identity["profile"],
        LABELS["role"]: identity["role"],
        LABELS["owner"]: identity["owner_id"],
    }


def plan(layout: Mapping[str, Any], source_root: str | os.PathLike[str],
         toolchain_id: str, profile: str = PROFILE) -> dict[str, Any]:
    source = _source(source_root)
    if not isinstance(toolchain_id, str) or not _IMAGE.fullmatch(toolchain_id):
        raise FrontendVolumeError("toolchain_id must be a full immutable image ID")
    if profile != PROFILE:
        raise FrontendVolumeError("only the frontend dev profile is supported")
    resolved = compose_project_identity(layout)
    if os.path.normcase(str(_source(resolved["source_root"]))) != os.path.normcase(str(source)):
        raise FrontendVolumeError("source_root differs from the registered checkout")
    project = resolved.get("project_id")
    worktree = resolved.get("worktree_id")
    if not isinstance(project, str) or not _ID.fullmatch(project):
        raise FrontendVolumeError("resolver project id is invalid")
    if not isinstance(worktree, str) or not _ID.fullmatch(worktree):
        raise FrontendVolumeError("resolver worktree id is invalid")
    compose_project = resolved.get("project_name")
    if not isinstance(compose_project, str) or not _ID.fullmatch(compose_project):
        raise FrontendVolumeError("resolver Compose project is invalid")
    ident = _identity(project, worktree, toolchain_id, profile)
    app = source / "apps" / "control-room"
    live = [
        {"type": "bind", "source": str(app / name),
         "target": f"{VOLUME_TARGET}/workspace/apps/control-room/{name}",
         "read_only": True, "bind": {"create_host_path": False}}
        for name in ("app", "src", "public", "scripts")
    ]
    labels = _base_labels(ident)
    return {
        "schema": SCHEMA, "identity": ident, "compose_project": compose_project,
        "source_root": str(source), "volume_name": ident["volume_name"],
        "volume_labels": labels,
        "container_labels": {**labels, LABELS["compose"]: compose_project},
        "compose_volume_declaration": {
            "frontend-development": {"name": ident["volume_name"], "external": True}},
        "development_mount": {
            "type": "volume", "source": "frontend-development",
            "target": VOLUME_TARGET, "read_only": False, "volume": {"nocopy": True}},
        "source_mount": {
            "type": "bind", "source": str(source), "target": SOURCE_TARGET,
            "read_only": True, "bind": {"create_host_path": False}},
        "live_source_mounts": live, "control_mount_target": CONTROL_TARGET,
        "owner_marker": VOLUME_TARGET + "/.fullmag-frontend-development-owner.json",
        "uid": UID, "gid": GID,
    }


def _check_plan(value: Mapping[str, Any]) -> dict[str, str]:
    if value.get("schema") != SCHEMA or not isinstance(value.get("identity"), Mapping):
        raise FrontendVolumeError("frontend volume plan schema is invalid")
    old = value["identity"]
    if any(not isinstance(old.get(key), str) for key in
           ("project_id", "worktree_id", "toolchain_image_id", "profile")):
        raise FrontendVolumeError("frontend volume plan identity is incomplete")
    if (not _ID.fullmatch(old["project_id"])
            or not _ID.fullmatch(old["worktree_id"])
            or not _IMAGE.fullmatch(old["toolchain_image_id"])
            or old["profile"] != PROFILE):
        raise FrontendVolumeError("frontend volume plan identity is invalid")
    expected = _identity(old["project_id"], old["worktree_id"],
                         old["toolchain_image_id"], old["profile"])
    if dict(old) != expected or value.get("volume_name") != expected["volume_name"]:
        raise FrontendVolumeError("frontend volume plan identity is not canonical")
    if value.get("development_mount") != {
        "type": "volume", "source": "frontend-development",
        "target": VOLUME_TARGET, "read_only": False, "volume": {"nocopy": True}}:
        raise FrontendVolumeError("frontend development mount is not canonical")
    if value.get("source_mount", {}).get("target") != SOURCE_TARGET:
        raise FrontendVolumeError("frontend source mount target is invalid")
    source = _source(value.get("source_root", ""))
    expected_source = {
        "type": "bind", "source": str(source), "target": SOURCE_TARGET,
        "read_only": True, "bind": {"create_host_path": False},
    }
    if value.get("source_mount") != expected_source:
        raise FrontendVolumeError("frontend source bind differs from the selected checkout")
    expected_live = [
        {
            "type": "bind", "source": str(source / "apps" / "control-room" / name),
            "target": f"{VOLUME_TARGET}/workspace/apps/control-room/{name}",
            "read_only": True, "bind": {"create_host_path": False},
        }
        for name in ("app", "src", "public", "scripts")
    ]
    if value.get("live_source_mounts") != expected_live:
        raise FrontendVolumeError("frontend live source binds differ from the fixed HMR contract")
    if value.get("compose_volume_declaration") != {
        "frontend-development": {"name": expected["volume_name"], "external": True}
    }:
        raise FrontendVolumeError("frontend Compose volume declaration is not canonical")
    if value.get("control_mount_target") != CONTROL_TARGET:
        raise FrontendVolumeError("frontend control mount target is invalid")
    return expected


def _nonce(value: Mapping[str, Any]) -> str:
    nonce = value.get("creation_id")
    if not isinstance(nonce, str) or not _NONCE.fullmatch(nonce):
        raise FrontendVolumeError("frontend volume lacks its creation-id attestation")
    return nonce


def _expected_volume_labels(value: Mapping[str, Any]) -> dict[str, str]:
    return {**_base_labels(_check_plan(value)), LABELS["creation"]: _nonce(value)}


def _docker(args: list[str], *, stdin: str | None = None,
            runner: Callable[..., Any] | None = None) -> Any:
    execute = subprocess.run if runner is None else runner
    environment = os.environ.copy()
    environment.pop("DOCKER_CONTEXT", None)
    environment.pop("DOCKER_HOST", None)
    try:
        return execute(
            ["docker", "--context", "desktop-linux", *args],
            input=stdin,
            text=True,
            encoding="utf-8",
            errors="strict",
            env=environment,
            capture_output=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise FrontendVolumeError(f"Docker operation outcome is unknown: {error}") from error


def _json_output(result: Any, label: str) -> Any:
    if getattr(result, "returncode", None) != 0:
        raise FrontendVolumeError(f"{label} failed: {str(getattr(result, 'stderr', ''))[:1500]}")
    raw = getattr(result, "stdout", "")
    if not isinstance(raw, str) or len(raw.encode()) > 1024 * 1024:
        raise FrontendVolumeError(f"{label} returned an invalid response")
    def unique(pairs):
        doc = {}
        for key, value in pairs:
            if key in doc:
                raise FrontendVolumeError(f"{label} JSON contains duplicate keys")
            doc[key] = value
        return doc
    try:
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, TypeError) as error:
        raise FrontendVolumeError(f"{label} did not return JSON") from error


def _volume_doc(value: Any) -> Mapping[str, Any]:
    if isinstance(value, list) and len(value) == 1:
        value = value[0]
    if not isinstance(value, Mapping):
        raise FrontendVolumeError("Docker volume inspect returned an unexpected shape")
    return value


def validate_volume(actual: Any, value: Mapping[str, Any]) -> None:
    expected = _expected_volume_labels(value)
    doc = _volume_doc(actual)
    if doc.get("Name") != value.get("volume_name"):
        raise FrontendVolumeError("Docker volume name differs from the frontend plan")
    if (doc.get("Driver"), doc.get("Scope")) != ("local", "local"):
        raise FrontendVolumeError("frontend volume must use the local Docker volume driver")
    if doc.get("Options") not in (None, {}):
        raise FrontendVolumeError("frontend volume has unexpected driver options")
    mountpoint = doc.get("Mountpoint")
    if not isinstance(mountpoint, str) or not mountpoint.startswith("/") or re.match(r"^[A-Za-z]:", mountpoint):
        raise FrontendVolumeError("Docker volume mountpoint is invalid")
    labels = doc.get("Labels")
    if not isinstance(labels, Mapping) or dict(labels) != expected:
        raise FrontendVolumeError("Docker volume labels do not prove exact ownership")


def _compose_document(value: Mapping[str, Any], image: str, operation: str) -> str:
    _check_plan(value)
    if not _IMAGE.fullmatch(image or "") or operation not in {"initialize", "verify"}:
        raise FrontendVolumeError("maintenance image or operation is invalid")
    path = Path(value["source_root"]) / "docker" / "all-in-one" / MAINTENANCE_COMPOSE
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise FrontendVolumeError("versioned maintenance Compose file is missing or oversized")
    try:
        doc = json.loads(path.read_bytes())
    except (OSError, UnicodeError, ValueError) as error:
        raise FrontendVolumeError("maintenance Compose file is invalid JSON") from error
    if not isinstance(doc, dict) or set(doc) != {"services", "volumes"}:
        raise FrontendVolumeError("maintenance Compose document has an unexpected shape")
    services, volumes = doc["services"], doc["volumes"]
    service_name = "frontend-development-volume-maintenance"
    if not isinstance(services, dict) or set(services) != {service_name}:
        raise FrontendVolumeError("maintenance Compose service set is invalid")
    if not isinstance(volumes, dict) or set(volumes) != {"frontend-development"}:
        raise FrontendVolumeError("maintenance Compose volume set is invalid")
    svc = services[service_name]
    required = {"image", "profiles", "entrypoint", "command", "user", "read_only",
                "network_mode", "pids_limit", "mem_limit", "cpus", "cap_drop",
                "security_opt", "labels", "environment", "volumes"}
    if not isinstance(svc, dict) or set(svc) != required:
        raise FrontendVolumeError("maintenance Compose service fields are invalid")
    if svc.get("image") != "__IMAGE_ID__" or svc.get("labels") != {}:
        raise FrontendVolumeError("maintenance Compose image/labels placeholders are invalid")
    if volumes["frontend-development"] != {"name": "__VOLUME_NAME__", "external": True}:
        raise FrontendVolumeError("maintenance external-volume declaration is invalid")
    if (svc["profiles"] != ["frontend-volume-maintenance-v1"]
            or svc["entrypoint"] != ENTRYPOINT
            or svc["command"] != ["__OPERATION__"]
            or svc["user"] != "65532:65532"
            or svc["read_only"] is not True or svc["network_mode"] != "none"
            or type(svc["pids_limit"]) is not int
            or svc["pids_limit"] != MAINTENANCE_PIDS_LIMIT
            or svc["mem_limit"] != MAINTENANCE_MEMORY_LIMIT
            or type(svc["cpus"]) is not float
            or svc["cpus"] != MAINTENANCE_CPUS
            or svc["cap_drop"] != ["ALL"]
            or svc["security_opt"] != ["no-new-privileges:true"]):
        raise FrontendVolumeError("maintenance Compose security/resource contract is invalid")
    expected_mounts = [
        {"type": "volume", "source": "frontend-development", "target": "/frontend",
         "read_only": False, "volume": {"nocopy": True}},
        {"type": "bind", "source": "__HELPER_SOURCE__",
         "target": "/opt/fullmag/frontend_volume_maintenance.py", "read_only": True,
         "bind": {"create_host_path": False}},
    ]
    if svc["volumes"] != expected_mounts:
        raise FrontendVolumeError("maintenance Compose mount contract is invalid")
    ident = value["identity"]
    env = {
        "PYTHONDONTWRITEBYTECODE": "1",
        "FULLMAG_FRONTEND_VOLUME_SCHEMA": SCHEMA,
        "FULLMAG_FRONTEND_VOLUME_OWNER_SCHEMA": "fullmag.frontend-development-owner.v1",
        "FULLMAG_FRONTEND_VOLUME_PROJECT_ID": "__PROJECT_ID__",
        "FULLMAG_FRONTEND_VOLUME_WORKTREE_ID": "__WORKTREE_ID__",
        "FULLMAG_FRONTEND_VOLUME_TOOLCHAIN_IMAGE_ID": "__TOOLCHAIN_IMAGE_ID__",
        "FULLMAG_FRONTEND_VOLUME_PROFILE": ident["profile"],
        "FULLMAG_FRONTEND_VOLUME_ROLE": "frontend-development",
        "FULLMAG_FRONTEND_VOLUME_OWNER_ID": "__OWNER_ID__",
        "FULLMAG_FRONTEND_VOLUME_CREATION_ID": "__CREATION_ID__",
        "FULLMAG_FRONTEND_VOLUME_NAME": "__VOLUME_NAME__",
        "FULLMAG_FRONTEND_VOLUME_UID": "65532",
        "FULLMAG_FRONTEND_VOLUME_GID": "65532",
        "FULLMAG_FRONTEND_VOLUME_OPERATION": "__OPERATION__",
    }
    if svc["environment"] != env:
        raise FrontendVolumeError("maintenance Compose environment differs from the fixed identity")
    svc["image"] = image
    svc["command"] = [operation]
    svc["environment"] = {
        **env,
        "FULLMAG_FRONTEND_VOLUME_PROJECT_ID": ident["project_id"],
        "FULLMAG_FRONTEND_VOLUME_WORKTREE_ID": ident["worktree_id"],
        "FULLMAG_FRONTEND_VOLUME_TOOLCHAIN_IMAGE_ID": ident["toolchain_image_id"],
        "FULLMAG_FRONTEND_VOLUME_OWNER_ID": ident["owner_id"],
        "FULLMAG_FRONTEND_VOLUME_CREATION_ID": _nonce(value),
        "FULLMAG_FRONTEND_VOLUME_NAME": value["volume_name"],
        "FULLMAG_FRONTEND_VOLUME_OPERATION": operation,
    }
    svc["volumes"][1]["source"] = str(Path(value["source_root"]) / "docker" / "all-in-one" / "frontend_volume_maintenance.py")
    volumes["frontend-development"]["name"] = value["volume_name"]
    return json.dumps(doc, sort_keys=True, separators=(",", ":"))


def _maintenance(value: Mapping[str, Any], image: str, operation: str,
                 runner: Callable[..., Any] | None) -> None:
    doc = _compose_document(value, image, operation)
    args = ["compose", "--project-name", value["compose_project"],
            "--profile", MAINTENANCE_PROFILE, "-f", "-", "run", "--rm",
            "--no-deps", "-T"]
    if operation == "initialize":
        args += ["--user", "0:0", "--cap-add", "CHOWN"]
    args += [MAINTENANCE_SERVICE, operation]
    response = _json_output(_docker(args, stdin=doc, runner=runner), "frontend maintenance helper")
    expected = {
        "verified": True, "owner_id": value["identity"]["owner_id"],
        "volume_name": value["volume_name"], "creation_id": _nonce(value),
    }
    if not isinstance(response, Mapping) or any(response.get(k) != v for k, v in expected.items()):
        raise FrontendVolumeError("maintenance helper did not attest the exact volume identity")


def ensure(value: Mapping[str, Any], *, source_root: str | os.PathLike[str],
           image_id: str, runner: Callable[..., Any] | None = None) -> dict[str, Any]:
    """Create and initialize only a volume created by this exact ensure call."""
    identity = _check_plan(value)
    source = _source(source_root)
    if str(source) != value.get("source_root") or not _IMAGE.fullmatch(image_id or ""):
        raise FrontendVolumeError("ensure source or immutable maintenance image differs from plan")
    name = identity["volume_name"]
    inspected = _docker(["volume", "inspect", name], runner=runner)
    created_here = getattr(inspected, "returncode", None) != 0
    if created_here:
        message = f"{getattr(inspected, 'stderr', '')}\n{getattr(inspected, 'stdout', '')}".lower()
        if not any(token in message for token in ("no such volume", "volume not found", "not found")):
            raise FrontendVolumeError(f"volume inspect has an unknown result: {message[:1500]}")
        nonce = uuid.uuid4().hex
        labels = {**_base_labels(identity), LABELS["creation"]: nonce}
        args = ["volume", "create", "--driver", "local"]
        for key, label in labels.items():
            args += ["--label", f"{key}={label}"]
        args.append(name)
        result = _docker(args, runner=runner)
        if getattr(result, "returncode", None) != 0:
            raise FrontendVolumeError(f"volume create outcome is unknown: {str(getattr(result, 'stderr', ''))[:1500]}")
        readback_result = _docker(["volume", "inspect", name], runner=runner)
    else:
        doc = _json_output(inspected, "frontend volume inspect")
        doc = _volume_doc(doc)
        labels = doc.get("Labels")
        if not isinstance(labels, Mapping) or any(labels.get(k) != v for k, v in _base_labels(identity).items()):
            raise FrontendVolumeError("existing frontend volume is unowned or belongs to another identity")
        nonce = labels.get(LABELS["creation"], "")
        if not _NONCE.fullmatch(nonce):
            raise FrontendVolumeError("existing frontend volume has no valid creation-id label")
        readback_result = inspected
    actual = _json_output(readback_result, "frontend volume readback")
    effective = dict(value)
    effective.update(
        creation_id=nonce,
        volume_labels={**_base_labels(identity), LABELS["creation"]: nonce},
        container_labels={**_base_labels(identity), LABELS["creation"]: nonce,
                          LABELS["compose"]: value["compose_project"]},
    )
    validate_volume(actual, effective)
    if created_here:
        _maintenance(effective, image_id, "initialize", runner)
    _maintenance(effective, image_id, "verify", runner)
    return effective


def _host_path(value: Any) -> Path:
    try:
        from run_managed_browser import host_path
        return Path(host_path(value)).resolve()
    except Exception as error:
        raise FrontendVolumeError("cannot resolve the inspected bind source") from error


def validate(actual: Mapping[str, Any], value: Mapping[str, Any]) -> None:
    """Attest the application container, writable volume, and readonly binds."""
    _check_plan(value)
    _nonce(value)
    config = actual.get("Config")
    host = actual.get("HostConfig")
    if not isinstance(config, Mapping) or not isinstance(host, Mapping):
        raise FrontendVolumeError("frontend container inspect is incomplete")
    labels = config.get("Labels")
    expected_labels = {**_expected_volume_labels(value), LABELS["compose"]: value["compose_project"]}
    if not isinstance(labels, Mapping):
        raise FrontendVolumeError("frontend container has no labels")
    selected = {k: v for k, v in labels.items() if isinstance(k, str) and k.startswith(PREFIX)}
    if selected != expected_labels:
        raise FrontendVolumeError("frontend container labels differ from the ensured volume")
    if config.get("User") != "65532:65532":
        raise FrontendVolumeError("frontend container must run with UID/GID 65532")
    if host.get("Privileged") is not False or host.get("ReadonlyRootfs") is not True:
        raise FrontendVolumeError("frontend container security configuration is invalid")
    if "ALL" not in host.get("CapDrop", []):
        raise FrontendVolumeError("frontend container must drop all capabilities")
    control_name = value.get("control_volume_name")
    if not isinstance(control_name, str) or re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,127}", control_name) is None:
        raise FrontendVolumeError("exact control volume name is required")
    expected = {
        VOLUME_TARGET: ("volume", value["volume_name"], True),
        SOURCE_TARGET: ("bind", value["source_root"], False),
        CONTROL_TARGET: ("volume", control_name, False),
    }
    live = value.get("live_source_mounts")
    if not isinstance(live, list) or len(live) != 4:
        raise FrontendVolumeError("frontend plan must contain exactly four live source mounts")
    for mount in live:
        if not isinstance(mount, Mapping) or mount.get("target") in expected:
            raise FrontendVolumeError("frontend live source mount plan is invalid")
        expected[mount["target"]] = ("bind", mount["source"], False)
    actual_mounts = actual.get("Mounts")
    if not isinstance(actual_mounts, list):
        raise FrontendVolumeError("frontend container mounts are missing")
    observed = {}
    for mount in actual_mounts:
        if not isinstance(mount, Mapping) or mount.get("Destination") in observed:
            raise FrontendVolumeError("frontend container has invalid or duplicate mounts")
        observed[mount.get("Destination")] = mount
    if set(observed) != set(expected):
        raise FrontendVolumeError("frontend container mount set differs from the fixed contract")
    for target, (kind, source, writable) in expected.items():
        mount = observed[target]
        if mount.get("Type") != kind or mount.get("RW") is not writable:
            raise FrontendVolumeError(f"frontend mount type/permissions are invalid: {target}")
        if kind == "volume":
            if mount.get("Name") != source:
                raise FrontendVolumeError(f"frontend volume name is invalid: {target}")
        elif _host_path(mount.get("Source")) != Path(source).resolve():
            raise FrontendVolumeError(f"frontend bind source is invalid: {target}")
    if not isinstance(actual.get("State"), Mapping) or actual["State"].get("Running") is not True:
        raise FrontendVolumeError("frontend development container is not running")


def compose_service_labels(value: Mapping[str, Any]) -> dict[str, str]:
    return {**_expected_volume_labels(value), LABELS["compose"]: value["compose_project"]}


__all__ = [
    "FrontendVolumeError", "SCHEMA", "SOURCE_TARGET", "CONTROL_TARGET",
    "VOLUME_TARGET", "plan", "ensure", "validate_volume", "validate",
    "compose_service_labels",
]
