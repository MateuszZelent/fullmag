"""Project-scoped Docker named volumes for shared dependency payloads.

This adapter creates and validates only exact Docker-managed local volumes.
It never resolves daemon mountpoints into host paths, starts containers, removes
volumes, or migrates existing data.  A caller supplies its already-governed
Docker command callback and runs the fixed initializer through its selected
Compose group's control helper.
"""

from __future__ import annotations

import hashlib
import json
import re
import textwrap
from typing import Any, Callable, Mapping

from docker_named_volume_safety import (
    DockerNamedVolumeSafetyError,
    validate_local_named_volume,
)

SCHEMA = "fullmag.shared-build-storage.v1"
VOLUME_DRIVER = "local"
PACKAGE_ROLE = "packages"
CARGO_ROLE = "cargo"
PNPM_ROLE = "pnpm"
VOLUME_ROLES = (PACKAGE_ROLE, CARGO_ROLE, PNPM_ROLE)

LABEL_SCHEMA = "com.fullmag.shared-build-storage.schema"
LABEL_PROJECT = "com.fullmag.shared-build-storage.project-id"
LABEL_ROLE = "com.fullmag.shared-build-storage.volume-role"
LABEL_INITIALIZER = "com.fullmag.shared-build-storage.initializer"
LABEL_UNIT = "com.fullmag.shared-build-storage.unit-key"

PACKAGE_VOLUME_PREFIX = "fullmag-shared-packages-v1"
CARGO_VOLUME_PREFIX = "fullmag-shared-cargo-v1"
PNPM_VOLUME_PREFIX = "fullmag-shared-pnpm-v1"

PACKAGE_ROOT_TARGET = "/opt/fullmag/package"
SHARED_BACKEND_TARGET = "/opt/fullmag/shared-backend"
SHARED_CARGO_TARGET = "/opt/fullmag/shared-cargo"
SHARED_PNPM_TARGET = "/opt/fullmag/shared-pnpm"
SHARED_GROUPS_DIRECTORY = "groups"
SHARED_ARTIFACTS_DIRECTORY = "artifacts"
SHARED_LOCKS_DIRECTORY = "locks"
SHARED_STAGING_DIRECTORY = "staging"
SHARED_GC_LOCK = ".gc.lock"
CARGO_HOME_DIRECTORY = "home"
CARGO_CACHE_DIRECTORIES = ("registry", "git")
PNPM_STORE_DIRECTORY = "store"
OWNER_UID = 65532
OWNER_GID = 65532

_PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_UNIT_KEY = re.compile(r"^[0-9a-f]{64}$")


class SharedBuildStorageError(RuntimeError):
    """A shared Docker volume is foreign, unsafe, or ambiguous."""


class VolumeNotFound(SharedBuildStorageError):
    """The provided Docker callback reports an absent named volume."""


def _project_id(value: Any) -> str:
    if not isinstance(value, str) or _PROJECT_ID.fullmatch(value) is None:
        raise SharedBuildStorageError("project_id is not a safe stable identifier")
    return value


def _unit_key(value: Any) -> str:
    if not isinstance(value, str) or _UNIT_KEY.fullmatch(value) is None:
        raise SharedBuildStorageError("unit_key must be a full lowercase SHA-256 key")
    return value


def shared_group(unit_key: str) -> str:
    return f"{SHARED_GROUPS_DIRECTORY}/{_unit_key(unit_key)}"


def shared_volume_names(project_id: str) -> dict[str, str]:
    """Return stable project-only names, independent of worktree/task identity."""

    project = _project_id(project_id)
    project_hash = hashlib.sha256(project.encode("utf-8")).hexdigest()[:24]
    return {
        PACKAGE_ROLE: f"{PACKAGE_VOLUME_PREFIX}-{project_hash}",
        CARGO_ROLE: f"{CARGO_VOLUME_PREFIX}-{project_hash}",
        PNPM_ROLE: f"{PNPM_VOLUME_PREFIX}-{project_hash}",
    }


def shared_volume_labels(project_id: str, role: str) -> dict[str, str]:
    project = _project_id(project_id)
    if role not in VOLUME_ROLES:
        raise SharedBuildStorageError(f"unknown shared build storage role: {role}")
    return {
        LABEL_SCHEMA: SCHEMA,
        LABEL_PROJECT: project,
        LABEL_ROLE: role,
    }


def volume_descriptors(project_id: str) -> dict[str, dict[str, Any]]:
    """Describe exact project-scoped volumes and their runtime guest roots."""

    names = shared_volume_names(project_id)
    targets = {
        PACKAGE_ROLE: SHARED_BACKEND_TARGET,
        CARGO_ROLE: SHARED_CARGO_TARGET,
        PNPM_ROLE: SHARED_PNPM_TARGET,
    }
    return {
        role: {
            "name": names[role],
            "role": role,
            "driver": VOLUME_DRIVER,
            "labels": shared_volume_labels(project_id, role),
            "target": targets[role],
            "external": True,
        }
        for role in VOLUME_ROLES
    }


def package_mount_descriptor(project_id: str, unit_key: str) -> dict[str, Any]:
    """Describe the private package alias into the project-shared volume."""

    descriptor = volume_descriptors(project_id)[PACKAGE_ROLE]
    return {
        "type": "volume",
        "source": descriptor["name"],
        "target": PACKAGE_ROOT_TARGET,
        "read_only": False,
        "volume": {"nocopy": True, "subpath": shared_group(unit_key)},
    }


def initializer_mount_descriptors(project_id: str) -> list[dict[str, Any]]:
    """Return the three whole-volume mounts used by the managed root helper."""

    descriptors = volume_descriptors(project_id)
    return [
        {
            "type": "volume",
            "source": descriptors[role]["name"],
            "target": descriptors[role]["target"],
            "read_only": False,
            "volume": {"nocopy": True},
        }
        for role in VOLUME_ROLES
    ]


def dependency_mount_descriptors(project_id: str) -> list[dict[str, Any]]:
    """Describe the writable cache subpaths attached to runtime services."""

    descriptors = volume_descriptors(project_id)
    subpaths = {CARGO_ROLE: CARGO_HOME_DIRECTORY, PNPM_ROLE: PNPM_STORE_DIRECTORY}
    targets = {CARGO_ROLE: SHARED_CARGO_TARGET, PNPM_ROLE: SHARED_PNPM_TARGET}
    return [
        {
            "type": "volume",
            "source": descriptors[role]["name"],
            "target": targets[role],
            "read_only": False,
            "volume": {"nocopy": True, "subpath": subpaths[role]},
        }
        for role in (CARGO_ROLE, PNPM_ROLE)
    ]


def initializer_labels(project_id: str, unit_key: str) -> dict[str, str]:
    """Return stable project + exact group identity for the short-lived helper."""

    return {
        LABEL_SCHEMA: SCHEMA,
        LABEL_PROJECT: _project_id(project_id),
        LABEL_INITIALIZER: "true",
        LABEL_UNIT: _unit_key(unit_key),
    }


def initializer_environment(unit_key: str) -> dict[str, str]:
    group = shared_group(unit_key)
    return {
        "FULLMAG_SHARED_BACKEND_UNIT_KEY": _unit_key(unit_key),
        "FULLMAG_SHARED_BACKEND_GROUP": group,
        "FULLMAG_SHARED_BACKEND_STORE": SHARED_BACKEND_TARGET,
        "FULLMAG_SHARED_CARGO_ROOT": SHARED_CARGO_TARGET,
        "FULLMAG_SHARED_PNPM_ROOT": SHARED_PNPM_TARGET,
        "FULLMAG_SHARED_BACKEND_OWNER_UID": str(OWNER_UID),
        "FULLMAG_SHARED_BACKEND_OWNER_GID": str(OWNER_GID),
    }


# This source is deliberately fixed. The selected project, unit and UID/GID
# arrive through validated environment values supplied by the host adapter.
# Directory traversal is descriptor-relative and O_NOFOLLOW at every level;
# only entries created by this invocation are handed to UID/GID 65532.
_INITIALIZER_PYTHON = textwrap.dedent(r'''
    import fcntl
    import json
    import os
    import re
    import stat
    import sys

    _O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
    _O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
    _CLOEXEC = getattr(os, "O_CLOEXEC", 0)
    _UNIT = re.compile(r"^[0-9a-f]{64}$")
    _OWNER_UID = 65532
    _OWNER_GID = 65532

    class InitError(RuntimeError):
        pass

    def _open_absolute_directory(path):
        if (not isinstance(path, str) or not path.startswith("/")
                or "\\" in path
                or any(part in {"", ".", ".."} for part in path.split("/")[1:])):
            raise InitError("initializer root is not a safe absolute path")
        descriptor = os.open("/", os.O_RDONLY | _O_DIRECTORY | _CLOEXEC)
        try:
            for component in path.split("/")[1:]:
                child = os.open(
                    component,
                    os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW | _CLOEXEC,
                    dir_fd=descriptor,
                )
                os.close(descriptor)
                descriptor = child
                if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    raise InitError("initializer path component is not a directory")
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def _ensure_directory(parent, name, uid, gid):
        if (not isinstance(name, str) or not name or name in {".", ".."}
                or "/" in name or "\\" in name):
            raise InitError("initializer directory name is unsafe")
        created = False
        try:
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            try:
                os.mkdir(name, 0o755, dir_fd=parent)
                created = True
            except FileExistsError:
                pass
            try:
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except OSError as error:
                raise InitError("initializer directory could not be inspected") from error
        except OSError as error:
            raise InitError("initializer directory could not be inspected") from error
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
            raise InitError("initializer entry is not a real directory")
        try:
            descriptor = os.open(
                name,
                os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW | _CLOEXEC,
                dir_fd=parent,
            )
        except OSError as error:
            raise InitError("initializer directory could not be opened safely") from error
        try:
            opened = os.fstat(descriptor)
            if (not stat.S_ISDIR(opened.st_mode)
                    or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
                raise InitError("initializer directory changed during open")
            if created:
                os.fchown(descriptor, uid, gid)
                opened = os.fstat(descriptor)
                if (opened.st_uid, opened.st_gid) != (uid, gid):
                    raise InitError("new initializer directory owner did not read back")
            elif (opened.st_uid, opened.st_gid) != (uid, gid):
                raise InitError("existing initializer directory has a foreign owner")
            if created:
                os.fsync(descriptor)
                os.fsync(parent)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def _ensure_lock_file(directory, name, uid, gid):
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | _CLOEXEC
        created = False
        try:
            descriptor = os.open(
                name, flags | os.O_EXCL, 0o600, dir_fd=directory
            )
            created = True
        except FileExistsError:
            try:
                descriptor = os.open(name, flags, dir_fd=directory)
            except OSError as error:
                raise InitError("shared cache lock could not be opened safely") from error
        except OSError as error:
            raise InitError("shared cache lock could not be created safely") from error
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise InitError("shared cache lock is not one regular file")
            if created:
                os.fchown(descriptor, uid, gid)
                os.fchmod(descriptor, 0o600)
                metadata = os.fstat(descriptor)
                if ((metadata.st_uid, metadata.st_gid) != (uid, gid)
                        or stat.S_IMODE(metadata.st_mode) != 0o600):
                    raise InitError("new shared cache lock owner did not read back")
            elif ((metadata.st_uid, metadata.st_gid) != (uid, gid)
                    or stat.S_IMODE(metadata.st_mode) != 0o600):
                raise InitError("existing shared cache lock has a foreign owner or mode")
            if created:
                os.fsync(descriptor)
                os.fsync(directory)
        finally:
            os.close(descriptor)

    def initialize_guest_storage(package_root, cargo_root, pnpm_root, unit_key,
                                 uid=_OWNER_UID, gid=_OWNER_GID):
        if not isinstance(unit_key, str) or _UNIT.fullmatch(unit_key) is None:
            raise InitError("shared backend unit key is invalid")
        roots = []
        lock_descriptor = None
        try:
            package = _open_absolute_directory(package_root)
            roots.append(package)
            cargo = _open_absolute_directory(cargo_root)
            roots.append(cargo)
            pnpm = _open_absolute_directory(pnpm_root)
            roots.append(pnpm)

            lock_name = ".fullmag-shared-build-storage.init.lock"
            flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | _CLOEXEC
            lock_descriptor = os.open(lock_name, flags, 0o600, dir_fd=package)
            lock = os.fstat(lock_descriptor)
            lock_owner = (os.geteuid(), os.getegid())
            if (not stat.S_ISREG(lock.st_mode) or lock.st_nlink != 1
                    or (lock.st_uid, lock.st_gid) != lock_owner
                    or stat.S_IMODE(lock.st_mode) != 0o600):
                raise InitError("shared build storage lock is unsafe")
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX)

            groups = _ensure_directory(package, "groups", uid, gid)
            try:
                group = _ensure_directory(groups, unit_key, uid, gid)
            finally:
                os.close(groups)
            os.close(group)
            for component in ("artifacts", "locks", "staging"):
                directory = _ensure_directory(package, component, uid, gid)
                os.close(directory)
            _ensure_lock_file(package, ".gc.lock", uid, gid)
            cargo_home = _ensure_directory(cargo, "home", uid, gid)
            try:
                for component in ("registry", "git"):
                    directory = _ensure_directory(cargo_home, component, uid, gid)
                    os.close(directory)
            finally:
                os.close(cargo_home)
            store = _ensure_directory(pnpm, "store", uid, gid)
            os.close(store)
            return {
                "schema": "fullmag.shared-build-storage-initializer.v1",
                "state": "ready",
                "unit_key": unit_key,
                "group": "groups/" + unit_key,
                "owner_uid": uid,
                "owner_gid": gid,
            }
        finally:
            if lock_descriptor is not None:
                try:
                    fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
                finally:
                    os.close(lock_descriptor)
            for descriptor in reversed(roots):
                os.close(descriptor)

    def main():
        unit_key = os.environ.get("FULLMAG_SHARED_BACKEND_UNIT_KEY", "")
        group = os.environ.get("FULLMAG_SHARED_BACKEND_GROUP", "")
        if group != "groups/" + unit_key:
            raise InitError("shared backend group does not match its unit key")
        if os.environ.get("FULLMAG_SHARED_BACKEND_STORE") != "/opt/fullmag/shared-backend":
            raise InitError("shared backend store target changed")
        if os.environ.get("FULLMAG_SHARED_CARGO_ROOT") != "/opt/fullmag/shared-cargo":
            raise InitError("shared cargo root target changed")
        if os.environ.get("FULLMAG_SHARED_PNPM_ROOT") != "/opt/fullmag/shared-pnpm":
            raise InitError("shared pnpm root target changed")
        uid = int(os.environ.get("FULLMAG_SHARED_BACKEND_OWNER_UID", "65532"))
        gid = int(os.environ.get("FULLMAG_SHARED_BACKEND_OWNER_GID", "65532"))
        if (uid, gid) != (_OWNER_UID, _OWNER_GID):
            raise InitError("shared build storage owner identity changed")
        result = initialize_guest_storage(
            "/opt/fullmag/shared-backend",
            "/opt/fullmag/shared-cargo",
            "/opt/fullmag/shared-pnpm",
            unit_key,
            uid,
            gid,
        )
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))

    if __name__ == "__main__":
        try:
            main()
        except Exception as error:
            print("shared build storage initialization failed: " + str(error), file=sys.stderr)
            raise SystemExit(2) from error
''')

INITIALIZER_SCRIPT = "python3 - <<'FULLMAG_SHARED_BUILD_STORAGE_INIT'\n" + _INITIALIZER_PYTHON + "\nFULLMAG_SHARED_BUILD_STORAGE_INIT"


def _normal_volume_document(value: Any, expected_name: str) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise SharedBuildStorageError("Docker volume inspect did not return JSON") from error
    if isinstance(value, list):
        if len(value) != 1:
            raise SharedBuildStorageError("Docker shared volume inspect is ambiguous")
        value = value[0]
    if not isinstance(value, Mapping):
        raise SharedBuildStorageError("Docker shared volume inspect is malformed")
    if value.get("Name") != expected_name:
        raise SharedBuildStorageError("Docker shared volume identity changed")
    return dict(value)


def validate_volume_document(
    document: Mapping[str, Any], project_id: str, role: str
) -> dict[str, Any]:
    project = _project_id(project_id)
    if role not in VOLUME_ROLES:
        raise SharedBuildStorageError(f"unknown shared build storage role: {role}")
    expected_name = shared_volume_names(project)[role]
    try:
        mountpoint = validate_local_named_volume(document, expected_name)
    except DockerNamedVolumeSafetyError as error:
        raise SharedBuildStorageError(str(error)) from error
    labels = document.get("Labels")
    expected_labels = shared_volume_labels(project, role)
    if not isinstance(labels, Mapping) or dict(labels) != expected_labels:
        raise SharedBuildStorageError("shared build volume labels are not exact")
    return {**dict(document), "Mountpoint": mountpoint, "Labels": dict(labels)}


def _create_volume(docker: Callable[..., Any], descriptor: Mapping[str, Any]) -> None:
    name = descriptor["name"]
    arguments: list[str] = ["volume", "create", "--driver", VOLUME_DRIVER]
    labels = descriptor["labels"]
    for key, value in labels.items():
        arguments.extend(("--label", f"{key}={value}"))
    # Do not add local-driver options: options may redirect storage to host data.
    arguments.append(name)
    result = docker(*arguments)
    if isinstance(result, str) and result.strip() and result.strip() != name:
        raise SharedBuildStorageError("Docker created a different shared build volume")


def ensure_volumes(
    docker: Callable[..., Any], project_id: str
) -> dict[str, dict[str, Any]]:
    """Create only absent exact project volumes and return revalidated inspect docs.

    The callback must raise this module's ``VolumeNotFound`` for an absent
    inspect target. Creation is limited to ``volume create`` with the local
    driver and exact stable project labels; no helper container is started.
    """

    if not callable(docker):
        raise SharedBuildStorageError("shared volume preparation requires a Docker callback")
    descriptors = volume_descriptors(project_id)
    documents: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for role, descriptor in descriptors.items():
        try:
            raw = docker("volume", "inspect", descriptor["name"])
        except VolumeNotFound:
            missing.append(role)
            continue
        documents[role] = _normal_volume_document(raw, descriptor["name"])
        validate_volume_document(documents[role], project_id, role)

    for role in missing:
        _create_volume(docker, descriptors[role])

    final: dict[str, dict[str, Any]] = {}
    for role, descriptor in descriptors.items():
        if role in documents and role not in missing:
            raw_document: Any = documents[role]
        else:
            try:
                raw_document = docker("volume", "inspect", descriptor["name"])
            except VolumeNotFound as error:
                raise SharedBuildStorageError("Docker did not publish the shared build volume") from error
        final[role] = validate_volume_document(
            _normal_volume_document(raw_document, descriptor["name"]), project_id, role
        )
    return final


def validate_initializer_receipt(receipt: Any, unit_key: str) -> dict[str, Any]:
    key = _unit_key(unit_key)
    if isinstance(receipt, str):
        try:
            receipt = json.loads(receipt)
        except json.JSONDecodeError as error:
            raise SharedBuildStorageError("shared build initializer returned invalid JSON") from error
    expected = {
        "schema": "fullmag.shared-build-storage-initializer.v1",
        "state": "ready",
        "unit_key": key,
        "group": shared_group(key),
        "owner_uid": OWNER_UID,
        "owner_gid": OWNER_GID,
    }
    if not isinstance(receipt, Mapping) or dict(receipt) != expected:
        raise SharedBuildStorageError("shared build initializer receipt is foreign or incomplete")
    return dict(expected)
