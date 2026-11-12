"""Read-only content and metadata manifests for Fullmag data trees.

The manifest proves only what was observed during its read. It is not proof of
a live quiescence guard, a mount/admission guard, or archive origin; callers
must hold their lifecycle guards and independently compare manifests at the
required boundaries.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
from pathlib import Path


_SCHEMA = "fullmag.data-tree-manifest.v1"
_ROLES = frozenset({"user_data", "state"})
_MANIFEST_KEYS = frozenset({"schema", "roots", "entries", "data_sha256", "totals"})
_ROOT_KEYS = frozenset({"path", "device", "inode"})
_ENTRY_BASE_KEYS = frozenset(
    {"role", "path", "kind", "mode", "uid", "gid", "mtime_ns", "xattrs"}
)
_FILE_ENTRY_KEYS = _ENTRY_BASE_KEYS | frozenset({"size", "sha256", "hardlink_to"})
_TOTAL_KEYS = frozenset(
    {"logical_bytes", "allocated_bytes", "entries", "files", "directories"}
)
_SHA256_LENGTH = 64
_CHUNK_SIZE = 1024 * 1024


def _fail(message: str) -> None:
    raise ValueError(message)


def _require_exact_dict(value, keys: frozenset[str], label: str) -> dict:
    if type(value) is not dict:
        _fail(f"{label} must be an object")
    if any(type(key) is not str for key in value):
        _fail(f"{label} keys must be strings")
    actual = frozenset(value)
    if actual != keys:
        missing = sorted(keys - actual)
        unknown = sorted(actual - keys)
        _fail(f"{label} keys are not closed (missing={missing}, unknown={unknown})")
    return value


def _require_int(value, label: str, *, minimum: int | None = None) -> int:
    if type(value) is not int:
        _fail(f"{label} must be an integer")
    if minimum is not None and value < minimum:
        _fail(f"{label} must be at least {minimum}")
    return value


def _require_utf8(value: str, label: str) -> str:
    if type(value) is not str:
        _fail(f"{label} must be a string")
    try:
        value.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise ValueError(f"{label} is not valid UTF-8 text") from error
    return value


def _canonical_absolute_path(value, label: str) -> tuple[str, tuple[str, ...]]:
    if isinstance(value, bytes) or not isinstance(value, (str, os.PathLike)):
        _fail(f"{label} must be an absolute canonical POSIX path")
    raw = os.fspath(value)
    if type(raw) is not str:
        _fail(f"{label} must be a text path")
    _require_utf8(raw, label)
    if not raw.startswith("/") or raw.startswith("//") or raw == "/":
        _fail(f"{label} must be an absolute canonical path below the filesystem root")
    components = tuple(raw[1:].split("/"))
    if any(component in {"", ".", ".."} for component in components):
        _fail(f"{label} must not contain empty, dot, or parent components")
    if "/" + "/".join(components) != raw:
        _fail(f"{label} is not canonical")
    return raw, components


def _canonical_relative_path(value, label: str, *, allow_root: bool) -> str:
    if type(value) is not str:
        _fail(f"{label} must be a relative POSIX path")
    _require_utf8(value, label)
    if value == "":
        if allow_root:
            return value
        _fail(f"{label} must name a non-root entry")
    if value.startswith("/"):
        _fail(f"{label} must be relative")
    components = value.split("/")
    if any(component in {"", ".", ".."} for component in components):
        _fail(f"{label} must not contain empty, dot, or parent components")
    return value


def _components_overlap(left: tuple[str, ...], right: tuple[str, ...]) -> bool:
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    return longer[: len(shorter)] == shorter


def _open_directory_path(components: tuple[str, ...]) -> int:
    required_flags = ("O_DIRECTORY", "O_NOFOLLOW")
    if any(not hasattr(os, name) for name in required_flags):
        _fail("descriptor-based no-follow directory traversal is unsupported")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open("/", flags)
    try:
        for component in components:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _kind_from_stat(info: os.stat_result, label: str) -> str:
    file_attributes = getattr(info, "st_file_attributes", 0)
    reparse_point = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if file_attributes & reparse_point:
        _fail(f"{label} is a reparse point")
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    if stat.S_ISREG(info.st_mode):
        return "file"
    if stat.S_ISLNK(info.st_mode):
        _fail(f"{label} is a symlink")
    _fail(f"{label} has an unsupported filesystem node type")


def _fingerprint(info: os.stat_result, kind: str, label: str) -> tuple[int, ...]:
    try:
        fingerprint = (
            int(info.st_dev),
            int(info.st_ino),
            int(stat.S_IFMT(info.st_mode)),
            int(stat.S_IMODE(info.st_mode)),
            int(info.st_uid),
            int(info.st_gid),
            int(info.st_size),
            int(info.st_mtime_ns),
            int(info.st_ctime_ns),
        )
        if kind == "file":
            fingerprint += (int(info.st_blocks),)
    except (AttributeError, OverflowError, TypeError, ValueError) as error:
        raise ValueError(f"{label} lacks supported filesystem metadata") from error
    return fingerprint


def _read_xattrs(descriptor: int, label: str) -> dict[str, str]:
    listxattr = getattr(os, "listxattr", None)
    getxattr = getattr(os, "getxattr", None)
    if listxattr is None or getxattr is None:
        _fail("descriptor-based extended-attribute inspection is unsupported")
    try:
        names = listxattr(descriptor)
    except (OSError, TypeError, ValueError) as error:
        raise ValueError(f"cannot list extended attributes for {label}: {error}") from error

    result: dict[str, str] = {}
    for raw_name in sorted(names):
        name = raw_name.decode("utf-8", "strict") if isinstance(raw_name, bytes) else raw_name
        _require_utf8(name, f"{label} xattr name")
        try:
            value = getxattr(descriptor, raw_name)
        except (OSError, TypeError, ValueError) as error:
            raise ValueError(
                f"cannot read extended attribute {name!r} for {label}: {error}"
            ) from error
        result[name] = base64.b64encode(value).decode("ascii")
    return dict(sorted(result.items()))


def _listdir_fd(descriptor: int) -> list[str]:
    try:
        names = os.listdir(descriptor)
    except (OSError, TypeError, ValueError) as error:
        raise ValueError(f"cannot enumerate directory descriptor: {error}") from error
    for name in names:
        _require_utf8(name, "directory entry name")
        if name in {"", ".", ".."} or "/" in name:
            _fail("directory contains a non-canonical entry name")
    return sorted(names)


def _hash_file_descriptor(descriptor: int) -> str:
    digest = hashlib.sha256()
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        while True:
            chunk = os.read(descriptor, _CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    except OSError as error:
        raise ValueError(f"cannot read regular file for hashing: {error}") from error
    return digest.hexdigest()


def _alias_string(role: str, relative_path: str) -> str:
    return f"{role}:{relative_path}"


def inventory_datasets(roots: dict[str, Path], *, maximum_entries: int = 100000) -> dict:
    """Return a deterministic content-and-metadata manifest for two data roots.

    Directory and file reads use pinned descriptors and ``O_NOFOLLOW``. Every
    observed node must remain on its root device, be a regular file or
    directory, and retain its observed identity and relevant metadata until
    the final walk check. Xattrs, including POSIX ACL xattrs, are read and
    retained without modification. ``hardlink_to`` uses ``role:path`` to
    identify the first sorted alias across both roots.
    """

    if type(roots) is not dict or any(type(role) is not str for role in roots):
        _fail("roots must be an object keyed by dataset role")
    if frozenset(roots) != _ROLES:
        _fail("roots must contain exactly user_data and state")
    if type(maximum_entries) is not int or maximum_entries <= 0:
        _fail("maximum_entries must be a positive integer")

    root_specs = {
        role: _canonical_absolute_path(roots[role], f"roots.{role}")
        for role in sorted(_ROLES)
    }
    if _components_overlap(root_specs["user_data"][1], root_specs["state"][1]):
        _fail("dataset roots must not lexically overlap")

    descriptors: list[int] = []
    states: list[dict] = []
    root_fds: dict[str, int] = {}
    root_info: dict[str, os.stat_result] = {}
    raw_entries: list[tuple[dict, tuple[int, int] | None, int | None]] = []
    inode_hashes: dict[tuple[int, int], str] = {}
    inode_fingerprints: dict[tuple[int, int], tuple[tuple[int, ...], dict[str, str]]] = {}
    device_by_role: dict[str, int] = {}

    def remember_node(
        descriptor: int,
        *,
        role: str,
        relative_path: str,
        expected_kind: str,
        expected_info: os.stat_result | None = None,
    ) -> dict:
        label = f"{role}:{relative_path}"
        if len(raw_entries) >= maximum_entries:
            _fail(f"manifest exceeds maximum_entries={maximum_entries}")
        info = os.fstat(descriptor)
        actual_kind = _kind_from_stat(info, label)
        if actual_kind != expected_kind:
            _fail(f"{label} changed filesystem node type while opening")
        if info.st_dev != device_by_role[role]:
            _fail(f"{label} crossed the root filesystem device")
        fingerprint = _fingerprint(info, actual_kind, label)
        if expected_info is not None and fingerprint != _fingerprint(
            expected_info, actual_kind, label
        ):
            _fail(f"{label} changed identity or metadata while opening")
        xattrs = _read_xattrs(descriptor, label)
        state = {
            "role": role,
            "path": relative_path,
            "kind": actual_kind,
            "fingerprint": fingerprint,
            "xattrs": xattrs,
            "directory_names": None,
        }
        states.append(state)
        entry = {
            "role": role,
            "path": relative_path,
            "kind": actual_kind,
            "mode": int(stat.S_IMODE(info.st_mode)),
            "uid": int(info.st_uid),
            "gid": int(info.st_gid),
            "mtime_ns": int(info.st_mtime_ns),
            "xattrs": xattrs,
        }
        raw_entries.append((entry, None, None))
        if actual_kind == "file":
            if not hasattr(info, "st_blocks"):
                _fail(f"{label} lacks allocated-block metadata")
            inode = (int(info.st_dev), int(info.st_ino))
            old = inode_fingerprints.get(inode)
            if old is not None and (old[0] != fingerprint or old[1] != xattrs):
                _fail(f"hardlink aliases for {label} disagree on observed metadata")
            inode_fingerprints.setdefault(inode, (fingerprint, xattrs))
            entry.update(
                {
                    "size": int(info.st_size),
                    "sha256": "",
                    "hardlink_to": None,
                }
            )
            return {"state": state, "entry": entry, "inode": inode, "info": info}
        return {"state": state, "entry": entry, "inode": None, "info": info}

    def verify_open_state(
        state: dict,
        descriptor: int,
        *,
        parent_fd: int | None = None,
        name: str | None = None,
    ) -> None:
        label = f"{state['role']}:{state['path']}"
        try:
            info = os.fstat(descriptor)
        except OSError as error:
            raise ValueError(f"cannot recheck {label}: {error}") from error
        kind = _kind_from_stat(info, label)
        if kind != state["kind"] or _fingerprint(info, kind, label) != state["fingerprint"]:
            _fail(f"{label} changed type, identity, size, mode, or mtime during walk")
        if _read_xattrs(descriptor, label) != state["xattrs"]:
            _fail(f"{label} extended attributes changed during walk")
        if state["directory_names"] is not None:
            if _listdir_fd(descriptor) != state["directory_names"]:
                _fail(f"{label} gained or lost entries during walk")
        if parent_fd is not None and name is not None:
            try:
                path_info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except OSError as error:
                raise ValueError(
                    f"{label} path changed or disappeared during walk: {error}"
                ) from error
            path_kind = _kind_from_stat(path_info, label)
            if (
                path_kind != kind
                or _fingerprint(path_info, path_kind, label) != state["fingerprint"]
            ):
                _fail(f"{label} path no longer names the inspected filesystem object")

    def open_relative_state(root_fd: int, role: str, relative_path: str, kind: str):
        if relative_path == "":
            return os.dup(root_fd), None, None
        components = relative_path.split("/")
        directory_flags = (
            os.O_RDONLY
            | os.O_DIRECTORY
            | os.O_NOFOLLOW
            | getattr(os, "O_CLOEXEC", 0)
        )
        current_fd = os.dup(root_fd)
        try:
            for component in components[:-1]:
                next_fd = os.open(component, directory_flags, dir_fd=current_fd)
                os.close(current_fd)
                current_fd = next_fd
                info = os.fstat(current_fd)
                if _kind_from_stat(info, f"{role}:{relative_path}") != "directory":
                    _fail(f"{role}:{relative_path} has a non-directory path component")
                if info.st_dev != device_by_role[role]:
                    _fail(f"{role}:{relative_path} crossed the root filesystem device")

            name = components[-1]
            label = f"{role}:{relative_path}"
            try:
                before = os.stat(name, dir_fd=current_fd, follow_symlinks=False)
            except OSError as error:
                raise ValueError(f"cannot recheck {label}: {error}") from error
            if _kind_from_stat(before, label) != kind:
                _fail(f"{label} changed filesystem node type during walk")
            if before.st_dev != device_by_role[role]:
                _fail(f"{label} crossed the root filesystem device")
            if kind == "directory":
                flags = directory_flags
            else:
                flags = (
                    os.O_RDONLY
                    | os.O_NOFOLLOW
                    | getattr(os, "O_NONBLOCK", 0)
                    | getattr(os, "O_CLOEXEC", 0)
                )
            descriptor = os.open(name, flags, dir_fd=current_fd)
            return descriptor, current_fd, name
        except Exception:
            os.close(current_fd)
            raise

    def walk_directory(
        state: dict,
        descriptor: int,
        *,
        parent_fd: int | None = None,
        entry_name: str | None = None,
    ) -> None:
        role = state["role"]
        relative_path = state["path"]
        names = _listdir_fd(descriptor)
        state["directory_names"] = names
        for child_name in names:
            child_path = (
                f"{relative_path}/{child_name}" if relative_path else child_name
            )
            label = f"{role}:{child_path}"
            try:
                before = os.stat(
                    child_name,
                    dir_fd=descriptor,
                    follow_symlinks=False,
                )
            except OSError as error:
                raise ValueError(f"cannot inspect {label}: {error}") from error
            kind = _kind_from_stat(before, label)
            if before.st_dev != device_by_role[role]:
                _fail(f"{label} crossed the root filesystem device")
            if kind == "directory":
                flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
            else:
                flags = (
                    os.O_RDONLY
                    | os.O_NOFOLLOW
                    | getattr(os, "O_NONBLOCK", 0)
                    | getattr(os, "O_CLOEXEC", 0)
                )
            try:
                child_fd = os.open(child_name, flags, dir_fd=descriptor)
            except OSError as error:
                raise ValueError(f"cannot open {label} without following links: {error}") from error
            try:
                remembered = remember_node(
                    child_fd,
                    role=role,
                    relative_path=child_path,
                    expected_kind=kind,
                    expected_info=before,
                )
                if kind == "directory":
                    walk_directory(
                        remembered["state"],
                        child_fd,
                        parent_fd=descriptor,
                        entry_name=child_name,
                    )
                else:
                    inode = remembered["inode"]
                    if inode not in inode_hashes:
                        inode_hashes[inode] = _hash_file_descriptor(child_fd)
                    remembered["entry"]["sha256"] = inode_hashes[inode]
                    raw_entries[-1] = (
                        remembered["entry"],
                        inode,
                        int(remembered["info"].st_blocks),
                    )
                    verify_open_state(
                        remembered["state"],
                        child_fd,
                        parent_fd=descriptor,
                        name=child_name,
                    )
            finally:
                os.close(child_fd)
        verify_open_state(
            state,
            descriptor,
            parent_fd=parent_fd,
            name=entry_name,
        )

    try:
        for role in sorted(_ROLES):
            path, components = root_specs[role]
            try:
                descriptor = _open_directory_path(components)
            except (OSError, ValueError) as error:
                raise ValueError(
                    f"cannot open dataset root {role} without following links: {error}"
                ) from error
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            if _kind_from_stat(info, f"{role} root") != "directory":
                _fail(f"{role} root must be a directory")
            root_fds[role] = descriptor
            root_info[role] = info
            device_by_role[role] = int(info.st_dev)

        identities = {
            role: (int(root_info[role].st_dev), int(root_info[role].st_ino))
            for role in sorted(_ROLES)
        }
        if identities["user_data"] == identities["state"]:
            _fail("dataset roots identify the same physical directory")

        for role in sorted(_ROLES):
            state_data = remember_node(
                root_fds[role],
                role=role,
                relative_path="",
                expected_kind="directory",
                expected_info=root_info[role],
            )
            walk_directory(state_data["state"], root_fds[role])

        if len(raw_entries) > maximum_entries:
            _fail(f"manifest exceeds maximum_entries={maximum_entries}")

        for state in states:
            role = state["role"]
            relative_path = state["path"]
            try:
                descriptor, parent_fd, name = open_relative_state(
                    root_fds[role],
                    role,
                    relative_path,
                    state["kind"],
                )
            except (OSError, ValueError) as error:
                raise ValueError(
                    f"{role}:{relative_path} changed or could not be reopened "
                    f"without following links: {error}"
                ) from error
            try:
                verify_open_state(
                    state,
                    descriptor,
                    parent_fd=parent_fd,
                    name=name,
                )
            finally:
                try:
                    os.close(descriptor)
                finally:
                    if parent_fd is not None:
                        os.close(parent_fd)

        for role in sorted(_ROLES):
            path, components = root_specs[role]
            try:
                current_fd = _open_directory_path(components)
            except (OSError, ValueError) as error:
                raise ValueError(f"dataset root {role} changed during walk: {error}") from error
            try:
                current_info = os.fstat(current_fd)
                if _fingerprint(current_info, "directory", f"{role} root") != _fingerprint(
                    root_info[role], "directory", f"{role} root"
                ):
                    _fail(f"dataset root {role} changed identity or metadata during walk")
                if _read_xattrs(current_fd, f"{role} root") != next(
                    state["xattrs"]
                    for state in states
                    if state["role"] == role and state["path"] == ""
                ):
                    _fail(f"dataset root {role} extended attributes changed during walk")
            finally:
                os.close(current_fd)

        raw_entries.sort(key=lambda item: (item[0]["role"], item[0]["path"]))
        first_alias_by_inode: dict[tuple[int, int], str] = {}
        entries: list[dict] = []
        logical_bytes = 0
        allocated_bytes = 0
        allocated_inodes: set[tuple[int, int]] = set()
        file_count = 0
        directory_count = 0
        for entry, inode, allocated_blocks in raw_entries:
            if entry["kind"] == "file":
                file_count += 1
                logical_bytes += entry["size"]
                alias = _alias_string(entry["role"], entry["path"])
                first_alias = first_alias_by_inode.get(inode)
                entry["hardlink_to"] = first_alias
                if first_alias is None:
                    first_alias_by_inode[inode] = alias
                if inode not in allocated_inodes:
                    allocated_bytes += allocated_blocks * 512
                    allocated_inodes.add(inode)
            else:
                directory_count += 1
            entries.append(entry)

        roots_result = {
            role: {
                "path": root_specs[role][0],
                "device": int(root_info[role].st_dev),
                "inode": int(root_info[role].st_ino),
            }
            for role in sorted(_ROLES)
        }
        totals = {
            "logical_bytes": logical_bytes,
            "allocated_bytes": allocated_bytes,
            "entries": len(entries),
            "files": file_count,
            "directories": directory_count,
        }
        return {
            "schema": _SCHEMA,
            "roots": roots_result,
            "entries": entries,
            "data_sha256": _entries_sha256(entries),
            "totals": totals,
        }
    except OSError as error:
        raise ValueError(f"filesystem metadata read failed: {error}") from error
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _entries_sha256(entries: list[dict]) -> str:
    canonical = json.dumps(
        entries,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8", "strict")
    return hashlib.sha256(canonical).hexdigest()


def _validate_xattrs(value, label: str) -> dict[str, str]:
    if type(value) is not dict:
        _fail(f"{label} must be an object")
    result = {}
    for name, encoded in value.items():
        _require_utf8(name, f"{label} name")
        if not name:
            _fail(f"{label} names must not be empty")
        if type(encoded) is not str:
            _fail(f"{label}[{name!r}] must be base64 text")
        try:
            decoded = base64.b64decode(encoded.encode("ascii"), validate=True)
        except (UnicodeEncodeError, ValueError) as error:
            raise ValueError(f"{label}[{name!r}] is not valid base64") from error
        if base64.b64encode(decoded).decode("ascii") != encoded:
            _fail(f"{label}[{name!r}] is not canonical base64")
        result[name] = encoded
    return dict(sorted(result.items()))


def _validate_manifest(value, label: str) -> dict:
    value = _require_exact_dict(value, _MANIFEST_KEYS, label)
    if value["schema"] != _SCHEMA:
        _fail(f"{label} has an unsupported schema")

    roots = value["roots"]
    if type(roots) is not dict or frozenset(roots) != _ROLES:
        _fail(f"{label}.roots must contain exactly user_data and state")
    root_components = {}
    for role in sorted(_ROLES):
        root = _require_exact_dict(roots[role], _ROOT_KEYS, f"{label}.roots.{role}")
        _, components = _canonical_absolute_path(root["path"], f"{label}.roots.{role}.path")
        root_components[role] = components
        _require_int(root["device"], f"{label}.roots.{role}.device", minimum=0)
        _require_int(root["inode"], f"{label}.roots.{role}.inode", minimum=0)
    if _components_overlap(root_components["user_data"], root_components["state"]):
        _fail(f"{label}.roots lexically overlap")

    entries = value["entries"]
    if type(entries) is not list:
        _fail(f"{label}.entries must be a list")
    seen_keys: set[tuple[str, str]] = set()
    normalized_entries = []
    previous_key = None
    first_file_aliases: dict[str, dict] = {}
    role_paths: dict[str, set[str]] = {role: set() for role in _ROLES}
    entry_kinds: dict[tuple[str, str], str] = {}
    logical_bytes = 0
    files = 0
    directories = 0
    for index, raw_entry in enumerate(entries):
        entry_label = f"{label}.entries[{index}]"
        if type(raw_entry) is not dict:
            _fail(f"{entry_label} must be an object")
        role = raw_entry.get("role")
        if type(role) is not str or role not in _ROLES:
            _fail(f"{entry_label}.role is unsupported")
        path = _canonical_relative_path(
            raw_entry.get("path"), f"{entry_label}.path", allow_root=True
        )
        kind = raw_entry.get("kind")
        if type(kind) is not str or kind not in {"directory", "file"}:
            _fail(f"{entry_label}.kind must be directory or file")
        expected_keys = _ENTRY_BASE_KEYS if kind == "directory" else _FILE_ENTRY_KEYS
        entry = _require_exact_dict(raw_entry, expected_keys, entry_label)
        mode = _require_int(entry["mode"], f"{entry_label}.mode", minimum=0)
        if mode > 0o7777:
            _fail(f"{entry_label}.mode exceeds POSIX mode bits")
        _require_int(entry["uid"], f"{entry_label}.uid", minimum=0)
        _require_int(entry["gid"], f"{entry_label}.gid", minimum=0)
        _require_int(entry["mtime_ns"], f"{entry_label}.mtime_ns")
        _validate_xattrs(entry["xattrs"], f"{entry_label}.xattrs")

        key = (role, path)
        if key in seen_keys:
            _fail(f"{entry_label} duplicates role/path {key!r}")
        if previous_key is not None and key < previous_key:
            _fail(f"{label}.entries are not sorted by role and path")
        seen_keys.add(key)
        previous_key = key
        role_paths[role].add(path)
        entry_kinds[key] = kind

        if path == "" and kind != "directory":
            _fail(f"{entry_label} root entry must be a directory")
        if path != "" and "/" in path:
            parent = path.rpartition("/")[0]
            if entry_kinds.get((role, parent)) != "directory":
                _fail(f"{entry_label} has no previously listed parent directory")
        if kind == "directory":
            directories += 1
        else:
            files += 1
            size = _require_int(entry["size"], f"{entry_label}.size", minimum=0)
            logical_bytes += size
            digest = entry["sha256"]
            if type(digest) is not str or len(digest) != _SHA256_LENGTH:
                _fail(f"{entry_label}.sha256 must be a lowercase SHA-256 digest")
            if any(character not in "0123456789abcdef" for character in digest):
                _fail(f"{entry_label}.sha256 must be a lowercase SHA-256 digest")
            target = entry["hardlink_to"]
            alias = _alias_string(role, path)
            if target is None:
                first_file_aliases[alias] = entry
            else:
                if type(target) is not str:
                    _fail(f"{entry_label}.hardlink_to must be null or a role:path string")
                target_role, separator, target_path = target.partition(":")
                if not separator or target_role not in _ROLES:
                    _fail(f"{entry_label}.hardlink_to has an invalid alias")
                _canonical_relative_path(
                    target_path, f"{entry_label}.hardlink_to path", allow_root=False
                )
                first = first_file_aliases.get(target)
                if first is None or target == alias:
                    _fail(f"{entry_label}.hardlink_to must name an earlier first alias")
                shared_fields = ("mode", "uid", "gid", "mtime_ns", "xattrs", "size", "sha256")
                if any(entry[field] != first[field] for field in shared_fields):
                    _fail(f"{entry_label} hardlink metadata differs from its first alias")
        normalized_entries.append(entry)

    for role in _ROLES:
        if "" not in role_paths[role]:
            _fail(f"{label}.entries lack the {role} root directory")
        for path in role_paths[role]:
            if path and "/" in path:
                parent = path.rpartition("/")[0]
                if entry_kinds.get((role, parent)) != "directory":
                    _fail(f"{label}.entries lack parent directory {role}:{parent}")

    digest = value["data_sha256"]
    if type(digest) is not str or len(digest) != _SHA256_LENGTH:
        _fail(f"{label}.data_sha256 must be a lowercase SHA-256 digest")
    if any(character not in "0123456789abcdef" for character in digest):
        _fail(f"{label}.data_sha256 must be a lowercase SHA-256 digest")
    actual_digest = _entries_sha256(normalized_entries)
    if digest != actual_digest:
        _fail(f"{label}.data_sha256 does not match its entries")

    totals = _require_exact_dict(value["totals"], _TOTAL_KEYS, f"{label}.totals")
    _require_int(totals["allocated_bytes"], f"{label}.totals.allocated_bytes", minimum=0)
    expected_totals = {
        "logical_bytes": logical_bytes,
        "entries": len(normalized_entries),
        "files": files,
        "directories": directories,
    }
    for key, expected in expected_totals.items():
        if _require_int(totals[key], f"{label}.totals.{key}", minimum=0) != expected:
            _fail(f"{label}.totals.{key} is inconsistent with entries")

    return value


def require_matching_data(source: dict, copied: dict) -> None:
    """Require self-consistent manifests with byte-and-metadata-identical trees.

    Root paths/device/inode and allocated bytes are location dependent and may
    differ. Dataset entries and their canonical digest must match exactly.
    """

    source = _validate_manifest(source, "source")
    copied = _validate_manifest(copied, "copied")
    if source["entries"] != copied["entries"]:
        _fail("source and copied dataset entries differ")
