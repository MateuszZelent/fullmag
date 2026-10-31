"""Stable per-Compose-group storage backed by its existing BuildControl volume."""
from __future__ import annotations

import base64
from collections.abc import Mapping
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import textwrap

from bootstrap_docker_toolchain import (
    CONTROL_ROOT,
    CONTROL_VOLUME_SCHEMA,
    control_volume_name,
)
from docker_build_control import BuildControlError, bounded_capture, docker_capture


SCHEMA = "fullmag.docker-group-storage-owner.v1"
ROLE_SUBPATHS = {
    "backend": "private/backend",
    "frontend": "private/frontend",
    "ledger": "private/ledger",
    "control": "",
}
DEFAULT_COMPOSE_NAMES = {
    "backend": "backend-build-cache",
    "frontend": "frontend-build",
    "ledger": "group-ledger",
    "control": "build-control",
}
_PROJECT_RE = re.compile(r"[a-z0-9][a-z0-9_-]*\Z")
_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]*\Z")
_NAMESPACE_RE = re.compile(r"namespaces/[0-9a-f]{32}\Z")
_ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
_TARGET_PART_RE = re.compile(r"[A-Za-z0-9._-]+\Z")


class GroupStorageError(BuildControlError):
    """The selected group volume or its private layout failed validation."""


def _fail(message: str) -> None:
    raise GroupStorageError(message)


def _namespace(control) -> str:
    value = getattr(control, "namespace", "")
    if value == "":
        return ""
    if not isinstance(value, str) or _NAMESPACE_RE.fullmatch(value) is None:
        _fail("Invalid BuildControl namespace for private group storage")
    return value


def role_subpath(control, role: str) -> str:
    """Return the fixed role path, prefixed by the authenticated namespace."""
    if role not in ROLE_SUBPATHS:
        _fail("Unknown private group storage role")
    namespace = _namespace(control)
    relative = ROLE_SUBPATHS[role]
    expected = "/".join(part for part in (namespace, relative) if part)
    subpath = getattr(control, "subpath", None)
    if not callable(subpath):
        _fail("BuildControl does not expose its validated subpath resolver")
    try:
        observed = subpath(relative)
    except Exception as error:
        raise GroupStorageError("BuildControl rejected the private role subpath") from error
    if observed != expected:
        _fail("BuildControl namespace resolver returned a different private subpath")
    return expected


def volume_declaration(control) -> dict[str, object]:
    """Return a Compose declaration for the existing external group volume."""
    volume = getattr(control, "volume", None)
    project = getattr(control, "project", None)
    if (not isinstance(project, str) or _PROJECT_RE.fullmatch(project) is None
            or volume != control_volume_name(project)):
        _fail("BuildControl volume is not the canonical stable group volume")
    return {"name": volume, "external": True}


def compose_volume_declarations(control, aliases: Mapping[str, str] | None = None) -> dict[str, dict[str, object]]:
    """Map caller-selected Compose aliases to the one external group volume."""
    names = dict(DEFAULT_COMPOSE_NAMES)
    if aliases is not None:
        if not isinstance(aliases, Mapping) or set(aliases) - set(DEFAULT_COMPOSE_NAMES):
            _fail("Compose volume aliases contain an unknown role")
        names.update(aliases)
    if (any(not isinstance(alias, str) or _PROJECT_RE.fullmatch(alias) is None
            for alias in names.values()) or len(set(names.values())) != len(names)):
        _fail("Compose volume aliases must be unique Compose-safe names")
    declaration = volume_declaration(control)
    return {names[role]: dict(declaration) for role in ROLE_SUBPATHS}


def _target_path(target: str) -> str:
    if not isinstance(target, str) or not target.startswith("/") or target == "/":
        _fail("Volume mount target must be a non-root absolute POSIX path")
    path = PurePosixPath(target)
    if (str(path) != target or ".." in path.parts or "\\" in target
            or any(_TARGET_PART_RE.fullmatch(part) is None for part in path.parts[1:])):
        _fail("Volume mount target is not a canonical safe POSIX path")
    return target


def compose_mount_descriptor(control, role: str, target: str, *,
                             compose_name: str | None = None,
                             read_only: bool = False) -> dict[str, object]:
    """Describe one Compose mount into the stable volume's fixed role path."""
    if type(read_only) is not bool:
        _fail("Volume mount read_only must be a boolean")
    alias = DEFAULT_COMPOSE_NAMES.get(role) if compose_name is None else compose_name
    if not isinstance(alias, str) or _PROJECT_RE.fullmatch(alias) is None:
        _fail("Invalid Compose volume alias")
    subpath = role_subpath(control, role)
    options: dict[str, object] = {"nocopy": True}
    if subpath:
        options["subpath"] = subpath
    return {
        "type": "volume",
        "source": alias,
        "target": _target_path(target),
        "read_only": read_only,
        "volume": options,
    }


def cli_mount_args(control, role: str, target: str, *, read_only: bool = False) -> list[str]:
    """Return Docker CLI ``--mount`` arguments for the same stable role path."""
    if type(read_only) is not bool:
        _fail("Volume mount read_only must be a boolean")
    declaration = volume_declaration(control)
    subpath = role_subpath(control, role)
    fields = ["type=volume", "src=" + str(declaration["name"]),
              "dst=" + _target_path(target)]
    if read_only:
        fields.append("readonly")
    fields.append("volume-nocopy")
    if subpath:
        fields.append("volume-subpath=" + subpath)
    return ["--mount", ",".join(fields)]


def _canonical_source(value: object) -> str:
    if not isinstance(value, (str, os.PathLike)):
        _fail("Source root must be an absolute canonical directory")
    raw = Path(value)
    if not raw.is_absolute():
        _fail("Source root must be absolute")
    try:
        resolved = raw.resolve(strict=True)
        metadata = raw.lstat()
    except OSError as error:
        raise GroupStorageError("Source root is unavailable") from error
    is_junction = getattr(raw, "is_junction", None)
    if (not resolved.is_dir() or raw.is_symlink()
            or (callable(is_junction) and is_junction())
            or os.path.normcase(os.path.normpath(str(raw)))
            != os.path.normcase(os.path.normpath(str(resolved)))):
        _fail("Source root must not be a symlink, junction, or non-canonical path")
    # lstat is intentional: it ensures the final source component itself is a real directory.
    if not stat.S_ISDIR(metadata.st_mode):
        _fail("Source root metadata is not a real directory")
    return str(resolved)


def _identity_text(identity: Mapping[str, object], key: str, pattern: re.Pattern[str]) -> str:
    value = identity.get(key)
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        _fail("BuildControl source identity is incomplete")
    return value


def owner_manifest(control, source_root: str | os.PathLike[str]) -> dict[str, object]:
    """Build the stable owner marker; deliberately excludes build fingerprints."""
    identity = getattr(control, "identity", None)
    project = getattr(control, "project", None)
    if not isinstance(identity, Mapping) or identity.get("project_name") != project:
        _fail("BuildControl source project identity differs")
    if not isinstance(project, str) or _PROJECT_RE.fullmatch(project) is None:
        _fail("BuildControl Compose project is invalid")
    canonical_source = _canonical_source(source_root)
    identity_source = _canonical_source(identity.get("source_root"))
    if os.path.normcase(identity_source) != os.path.normcase(canonical_source):
        _fail("Selected source root differs from the registered BuildControl source")
    volume = str(volume_declaration(control)["name"])
    namespace = _namespace(control)
    return {
        "schema": SCHEMA,
        "compose_project": project,
        "control_volume": volume,
        "control_namespace": namespace,
        "source_project_id": _identity_text(identity, "project_id", _ID_RE),
        "source_worktree_id": _identity_text(identity, "worktree_id", _ID_RE),
        "source_root": canonical_source,
        "layout": {
            "version": 1,
            "private_root": "private",
            "roles": {role: path for role, path in ROLE_SUBPATHS.items() if role != "control"},
        },
    }


def _validate_operation(control, operation, source_root: str) -> None:
    if getattr(control, "_active_operation", None) is not operation:
        _fail("Private group storage requires this BuildControl's active operation")
    if not isinstance(operation, Mapping):
        _fail("Active BuildControl operation is malformed")
    receipt = operation.get("receipt")
    if not isinstance(receipt, Mapping):
        _fail("Active BuildControl operation has no receipt")
    attempt = receipt.get("attempt")
    phase = receipt.get("phase")
    if (not isinstance(attempt, str) or _ATTEMPT_RE.fullmatch(attempt) is None
            or not isinstance(phase, str) or re.fullmatch(r"[a-z][a-z0-9-]+", phase) is None
            or operation.get("root") != f"{phase}/attempts/{attempt}"):
        _fail("Active BuildControl operation identity is invalid")
    if (receipt.get("compose_project") != control.project
            or receipt.get("control_volume") != control.volume):
        _fail("Active operation belongs to another Compose group")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping):
        _fail("Active BuildControl operation has no source-bound inputs")
    input_source = _canonical_source(inputs.get("source_root"))
    if os.path.normcase(input_source) != os.path.normcase(source_root):
        _fail("Active operation source root differs from the selected checkout")


def _inspect_existing_volume(control, docker) -> None:
    expected_name = str(volume_declaration(control)["name"])
    expected_labels = {
        "com.fullmag.compose.project": control.project,
        "com.fullmag.toolchain.control.schema": CONTROL_VOLUME_SCHEMA,
        "com.fullmag.toolchain.control.project": control.project,
        "com.fullmag.toolchain.control.mount": CONTROL_ROOT,
    }
    if getattr(control, "shared_labels", None) != expected_labels:
        _fail("BuildControl shared labels are not canonical")
    observed = docker("volume", "inspect", expected_name, allow_failure=True)
    if getattr(observed, "returncode", 1) != 0:
        _fail("Canonical BuildControl volume is absent or cannot be inspected")
    try:
        records = json.loads(observed.stdout)
    except (TypeError, ValueError, UnicodeDecodeError) as error:
        raise GroupStorageError("Canonical BuildControl volume inspection is malformed") from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], Mapping):
        _fail("Canonical BuildControl volume inspection is ambiguous")
    record = records[0]
    labels = record.get("Labels")
    if (record.get("Name") != expected_name or record.get("Driver") != "local"
            or record.get("Options") not in (None, {}) or not isinstance(labels, Mapping)
            or any(labels.get(key) != value for key, value in expected_labels.items())):
        _fail("Existing BuildControl volume ownership or backing differs")


def _initializer_script(manifest: Mapping[str, object]) -> str:
    payload = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    encoded = base64.b64encode(payload).decode("ascii")
    return textwrap.dedent(f'''\
        python3 - <<'PY'
        import base64
        import json
        import os
        import stat

        expected = json.loads(base64.b64decode("{encoded}", validate=True))
        expected_marker = (json.dumps(expected, sort_keys=True, separators=(",", ":")) + "\\n").encode("utf-8")
        if os.geteuid() != 0:
            raise SystemExit("group storage initialization requires the bounded root helper")
        dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        root_fd = os.open("/control", dir_flags)
        private_fd = None
        try:
            try:
                private_fd = os.open("private", dir_flags, dir_fd=root_fd)
            except FileNotFoundError:
                os.mkdir("private", 0o755, dir_fd=root_fd)
                private_fd = os.open("private", dir_flags, dir_fd=root_fd)
            private_stat = os.fstat(private_fd)
            if not stat.S_ISDIR(private_stat.st_mode):
                raise SystemExit("private group storage root is not a directory")
            mode = stat.S_IMODE(private_stat.st_mode)
            service_traverse = ((private_stat.st_gid == 65532 and mode & stat.S_IXGRP)
                                or mode & stat.S_IXOTH)
            service_write = ((private_stat.st_gid == 65532 and mode & stat.S_IWGRP)
                             or mode & stat.S_IWOTH)
            if private_stat.st_uid != 0 or not service_traverse or service_write:
                raise SystemExit("private group storage root has unsafe owner or service permissions")

            marker_fd = None
            try:
                marker_fd = os.open(".owner.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                    dir_fd=private_fd)
            except FileNotFoundError:
                if os.listdir(private_fd):
                    raise SystemExit("unmarked private group storage contains existing data")
                fresh = True
            else:
                marker_stat = os.fstat(marker_fd)
                if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_size > 65536:
                    raise SystemExit("private group storage owner marker is unsafe")
                with os.fdopen(marker_fd, "rb", closefd=False) as stream:
                    existing_bytes = stream.read(65537)
                existing = json.loads(existing_bytes.decode("utf-8"))
                if existing != expected or existing_bytes != expected_marker:
                    raise SystemExit("private group storage owner marker belongs to another source")
                fresh = False
            finally:
                if marker_fd is not None:
                    os.close(marker_fd)

            roles = expected["layout"]["roles"]
            allowed = set(roles.values())
            if allowed != {{"private/backend", "private/frontend", "private/ledger"}}:
                raise SystemExit("private group storage role layout is invalid")
            for name in ("backend", "frontend", "ledger"):
                try:
                    role_fd = os.open(name, dir_flags, dir_fd=private_fd)
                except FileNotFoundError:
                    if not fresh:
                        os.mkdir(name, 0o750, dir_fd=private_fd)
                    else:
                        os.mkdir(name, 0o750, dir_fd=private_fd)
                    role_fd = os.open(name, dir_flags, dir_fd=private_fd)
                try:
                    role_stat = os.fstat(role_fd)
                    if not stat.S_ISDIR(role_stat.st_mode):
                        raise SystemExit("private group storage role is not a directory")
                    os.fchown(role_fd, 65532, 65532)
                    os.fchmod(role_fd, 0o750)
                finally:
                    os.close(role_fd)

            names = set(os.listdir(private_fd))
            role_names = {{"backend", "frontend", "ledger"}}
            expected_names = role_names if fresh else role_names | {{".owner.json"}}
            if names != expected_names:
                raise SystemExit("private group storage contains an unexpected top-level entry")
            if fresh:
                marker_fd = os.open(".owner.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                    | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=private_fd)
                try:
                    view = memoryview(expected_marker)
                    while view:
                        written = os.write(marker_fd, view)
                        view = view[written:]
                    os.fchmod(marker_fd, 0o644)
                    os.fsync(marker_fd)
                finally:
                    os.close(marker_fd)
            os.fsync(private_fd)
        finally:
            if private_fd is not None:
                os.close(private_fd)
            os.close(root_fd)
        PY
    ''')


def prepare(control, operation, source_root: str | os.PathLike[str], *,
            docker=None, bounded=None) -> dict[str, object]:
    """Initialize exact role leaves in an already-created group volume.

    The caller must hold the same BuildControl operation for all related cache
    actions. This function never creates a Docker volume.
    """
    try:
        manifest = owner_manifest(control, source_root)
        _validate_operation(control, operation, str(manifest["source_root"]))
        _inspect_existing_volume(control, docker or docker_capture)
        command = control.helper_args(_initializer_script(manifest), initialize=True)
        result = (bounded or bounded_capture)(command, data=b"", timeout=120)
    except GroupStorageError:
        raise
    except BuildControlError as error:
        raise GroupStorageError("BuildControl refused private group storage preparation") from error
    except Exception as error:
        raise GroupStorageError("Private group storage preparation failed closed") from error
    if getattr(result, "returncode", 1) != 0:
        raise GroupStorageError("Private group storage initializer failed; existing data retained")
    return manifest
