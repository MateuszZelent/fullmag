"""Linux POSIX-ACL admission for an explicitly selected script-output tree."""
from __future__ import annotations

import errno
import os
from pathlib import Path
import stat
import struct


RUNTIME_UID = 65532
MAX_OUTPUT_DIRECTORIES = 10_000
MAX_OUTPUT_ENTRIES = 100_000
MAX_OUTPUT_DEPTH = 64

_ACL_ACCESS = "system.posix_acl_access"
_ACL_DEFAULT = "system.posix_acl_default"
_ACL_VERSION = 2
_ACL_UNDEFINED_ID = 0xFFFFFFFF
_ACL_USER_OBJ = 0x01
_ACL_USER = 0x02
_ACL_GROUP_OBJ = 0x04
_ACL_GROUP = 0x08
_ACL_MASK = 0x10
_ACL_OTHER = 0x20
_ACL_REQUIRED_TAGS = {_ACL_USER_OBJ, _ACL_GROUP_OBJ, _ACL_OTHER}
_ACL_TAG_ORDER = {
    _ACL_USER_OBJ: 0,
    _ACL_USER: 1,
    _ACL_GROUP_OBJ: 2,
    _ACL_GROUP: 3,
    _ACL_MASK: 4,
    _ACL_OTHER: 5,
}
_ACL_GROUP_CLASS_TAGS = {_ACL_USER, _ACL_GROUP_OBJ, _ACL_GROUP}
_ACL_MISSING_ERRNOS = {errno.ENODATA, getattr(errno, "ENOATTR", errno.ENODATA)}
_OPEN_DIRECTORY = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
_OPEN_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class ScriptOutputPermissionError(ValueError):
    """The opted-in output tree cannot be safely admitted to the runtime UID."""


def _canonical_entries(entries):
    return sorted(entries, key=lambda entry: (
        _ACL_TAG_ORDER[entry[0]],
        entry[2] if entry[0] in {_ACL_USER, _ACL_GROUP} else 0,
    ))


def _decode_acl(raw: bytes, *, label: str):
    if not isinstance(raw, bytes) or len(raw) < 4 or (len(raw) - 4) % 8:
        raise ScriptOutputPermissionError(label + " has a malformed POSIX ACL length")
    version = struct.unpack_from("<I", raw)[0]
    if version != _ACL_VERSION:
        raise ScriptOutputPermissionError(label + " has an unsupported POSIX ACL version")
    entries = [struct.unpack_from("<HHI", raw, offset)
               for offset in range(4, len(raw), 8)]
    if not entries:
        raise ScriptOutputPermissionError(label + " has an empty POSIX ACL")
    for tag, perm, identifier in entries:
        if tag not in _ACL_TAG_ORDER or perm & ~0x7:
            raise ScriptOutputPermissionError(label + " has an unsupported POSIX ACL entry")
        if tag in {_ACL_USER_OBJ, _ACL_GROUP_OBJ, _ACL_MASK, _ACL_OTHER}:
            if identifier != _ACL_UNDEFINED_ID:
                raise ScriptOutputPermissionError(label + " has an invalid POSIX ACL base-entry id")
        elif identifier == _ACL_UNDEFINED_ID:
            raise ScriptOutputPermissionError(label + " has an invalid POSIX ACL named-entry id")
    if entries != _canonical_entries(entries):
        raise ScriptOutputPermissionError(label + " has noncanonical POSIX ACL ordering")
    for tag in _ACL_REQUIRED_TAGS:
        if sum(entry[0] == tag for entry in entries) != 1:
            raise ScriptOutputPermissionError(label + " has missing or duplicate POSIX ACL base entries")
    if sum(entry[0] == _ACL_MASK for entry in entries) > 1:
        raise ScriptOutputPermissionError(label + " has duplicate POSIX ACL masks")
    for tag in {_ACL_USER, _ACL_GROUP}:
        identifiers = [entry[2] for entry in entries if entry[0] == tag]
        if len(identifiers) != len(set(identifiers)):
            raise ScriptOutputPermissionError(label + " has duplicate POSIX ACL named entries")
    if any(entry[0] in {_ACL_USER, _ACL_GROUP} for entry in entries) and not any(
        entry[0] == _ACL_MASK for entry in entries
    ):
        raise ScriptOutputPermissionError(label + " has named POSIX ACL entries without a mask")
    return entries


def _encode_acl(entries):
    canonical = _canonical_entries(entries)
    if canonical != entries:
        raise ScriptOutputPermissionError("internal POSIX ACL entries are not canonical")
    return struct.pack("<I", _ACL_VERSION) + b"".join(
        struct.pack("<HHI", *entry) for entry in entries
    )


def _augment_acl(raw: bytes | None, *, operator_uid: int, runtime_uid: int,
                 mode: int, default: bool) -> bytes:
    """Add runtime access and (for defaults) operator access without widening old ACL grants."""
    if raw is None and default:
        named = sorted({operator_uid, runtime_uid})
        entries = [(_ACL_USER_OBJ, 0x7, _ACL_UNDEFINED_ID)]
        entries.extend((_ACL_USER, 0x7, uid) for uid in named)
        entries.extend(((_ACL_GROUP_OBJ, 0, _ACL_UNDEFINED_ID),
                        (_ACL_MASK, 0x7, _ACL_UNDEFINED_ID),
                        (_ACL_OTHER, 0, _ACL_UNDEFINED_ID)))
        return _encode_acl(entries)

    if raw is None:
        entries = [
            (_ACL_USER_OBJ, (mode >> 6) & 0x7, _ACL_UNDEFINED_ID),
            (_ACL_GROUP_OBJ, (mode >> 3) & 0x7, _ACL_UNDEFINED_ID),
            (_ACL_OTHER, mode & 0x7, _ACL_UNDEFINED_ID),
        ]
    else:
        entries = _decode_acl(raw, label="script-output directory")

    old_mask = next((entry[1] for entry in entries if entry[0] == _ACL_MASK),
                    next(entry[1] for entry in entries if entry[0] == _ACL_GROUP_OBJ))
    updated = []
    for tag, perm, identifier in entries:
        if tag in _ACL_GROUP_CLASS_TAGS:
            perm &= old_mask
        updated.append((tag, perm, identifier))

    target_uids = {runtime_uid}
    if default:
        target_uids.add(operator_uid)
    for uid in target_uids:
        found = False
        for index, (tag, perm, identifier) in enumerate(updated):
            if tag == _ACL_USER and identifier == uid:
                updated[index] = (tag, 0x7, identifier)
                found = True
                break
        if not found:
            updated.append((_ACL_USER, 0x7, uid))

    if any(entry[0] in {_ACL_USER, _ACL_GROUP} for entry in updated):
        found_mask = False
        for index, (tag, _perm, identifier) in enumerate(updated):
            if tag == _ACL_MASK:
                updated[index] = (tag, 0x7, identifier)
                found_mask = True
                break
        if not found_mask:
            updated.append((_ACL_MASK, 0x7, _ACL_UNDEFINED_ID))
    return _encode_acl(_canonical_entries(updated))


def _raw_acl(descriptor: int, name: str, *, label: str):
    try:
        return os.getxattr(descriptor, name)
    except OSError as error:
        if error.errno in _ACL_MISSING_ERRNOS:
            return None
        if error.errno in {errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)}:
            raise ScriptOutputPermissionError(label + " filesystem does not support POSIX ACLs") from error
        raise ScriptOutputPermissionError("cannot read " + label + " POSIX ACL: " + str(error)) from error


def _effective_named_user(entries, uid: int) -> int:
    mask = next((perm for tag, perm, _identifier in entries if tag == _ACL_MASK),
                next(perm for tag, perm, _identifier in entries if tag == _ACL_GROUP_OBJ))
    return next((perm & mask for tag, perm, identifier in entries
                 if tag == _ACL_USER and identifier == uid), 0)


def _access_sufficient(entries, *, owner_uid: int, runtime_uid: int) -> bool:
    if runtime_uid == owner_uid:
        runtime = next(perm for tag, perm, _identifier in entries if tag == _ACL_USER_OBJ)
    else:
        runtime = _effective_named_user(entries, runtime_uid)
    return runtime & 0x7 == 0x7


def _default_sufficient(entries, *, operator_uid: int, runtime_uid: int) -> bool:
    if entries is None:
        return False
    return (_effective_named_user(entries, runtime_uid) & 0x7 == 0x7
            and _effective_named_user(entries, operator_uid) & 0x7 == 0x7)


def _foreign_directory_already_admitted(owner_uid: int, operator_uid: int,
                                        access_entries, default_entries) -> bool:
    if owner_uid == operator_uid:
        return True
    return (_access_sufficient(access_entries, owner_uid=owner_uid, runtime_uid=RUNTIME_UID)
            and _default_sufficient(default_entries, operator_uid=operator_uid,
                                    runtime_uid=RUNTIME_UID))


def _open_absolute_directory(path: Path) -> int:
    if not path.is_absolute() or ".." in path.parts:
        raise ScriptOutputPermissionError("script-output directory must be absolute and traversal-free")
    descriptor = os.open("/", _OPEN_DIRECTORY)
    try:
        for component in path.parts[1:]:
            if component in {"", ".", ".."}:
                raise ScriptOutputPermissionError("script-output path has an unsafe component")
            child = os.open(component, _OPEN_DIRECTORY | _OPEN_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _identity(metadata):
    return metadata.st_dev, metadata.st_ino, metadata.st_uid, stat.S_IFMT(metadata.st_mode)


def _walk_output_tree(root: Path, root_descriptor: int, *, max_directories: int, max_entries: int):
    root_info = os.fstat(root_descriptor)
    if not stat.S_ISDIR(root_info.st_mode):
        raise ScriptOutputPermissionError("selected script-output path is not a directory")
    records = [{"fd": root_descriptor, "parent": None, "name": None,
                "identity": _identity(root_info), "path": root}]
    entry_count = 0

    def visit(index: int, depth: int):
        nonlocal entry_count
        if depth > MAX_OUTPUT_DEPTH:
            raise ScriptOutputPermissionError("script-output directory nesting exceeds its safety bound")
        descriptor = records[index]["fd"]
        with os.scandir(descriptor) as children:
            for child in children:
                entry_count += 1
                if entry_count > max_entries:
                    raise ScriptOutputPermissionError("script-output tree exceeds its entry-count bound")
                name = child.name
                if name.casefold() == ".git":
                    raise ScriptOutputPermissionError(
                        "script-output tree contains Git administration: "
                        + str(records[index]["path"] / name)
                    )
                metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if stat.S_ISLNK(metadata.st_mode):
                    raise ScriptOutputPermissionError(
                        "script-output tree contains a symlink: " + str(records[index]["path"] / name)
                    )
                root_device = root_info.st_dev
                if metadata.st_dev != root_device:
                    raise ScriptOutputPermissionError(
                        "script-output tree crosses a filesystem boundary: "
                        + str(records[index]["path"] / name)
                    )
                if stat.S_ISREG(metadata.st_mode):
                    continue
                if not stat.S_ISDIR(metadata.st_mode):
                    raise ScriptOutputPermissionError(
                        "script-output tree contains a special file: "
                        + str(records[index]["path"] / name)
                    )
                if len(records) >= max_directories:
                    raise ScriptOutputPermissionError("script-output tree exceeds its directory-count bound")
                child_fd = os.open(name, _OPEN_DIRECTORY | _OPEN_NOFOLLOW, dir_fd=descriptor)
                child_info = os.fstat(child_fd)
                if _identity(child_info) != _identity(metadata):
                    os.close(child_fd)
                    raise ScriptOutputPermissionError("script-output directory changed during validation")
                child_index = len(records)
                records.append({"fd": child_fd, "parent": index, "name": name,
                                "identity": _identity(child_info),
                                "path": records[index]["path"] / name})
                visit(child_index, depth + 1)

    try:
        visit(0, 0)
        return records
    except BaseException:
        for record in records[1:]:
            try:
                os.close(record["fd"])
            except OSError:
                pass
        raise


def _revalidate_linkage(records: list[dict], index: int, root: Path):
    reopened = _open_absolute_directory(root)
    try:
        if _identity(os.fstat(reopened)) != records[0]["identity"]:
            raise ScriptOutputPermissionError("selected script-output directory changed during admission")
    finally:
        os.close(reopened)
    chain = []
    current = index
    while current:
        chain.append(current)
        current = records[current]["parent"]
    for child_index in reversed(chain):
        record = records[child_index]
        parent_fd = records[record["parent"]]["fd"]
        current = os.stat(record["name"], dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or _identity(current) != record["identity"]:
            raise ScriptOutputPermissionError("script-output directory moved during admission")


def _write_acl(descriptor: int, name: str, value: bytes | None):
    if value is None:
        os.removexattr(descriptor, name)
    else:
        os.setxattr(descriptor, name, value)


def prepare_output_tree(path, *, max_directories: int = MAX_OUTPUT_DIRECTORIES,
                        max_entries: int = MAX_OUTPUT_ENTRIES) -> int:
    """Admit UID 65532 beneath one explicitly opted-in directory, preserving ownership.

    Existing regular files are never opened or changed. Existing ACLs are
    normalized before mask widening so every prior group-class principal keeps
    its effective rights. New default ACLs give only the operator and runtime
    access to newly created output entries.
    """
    root = Path(path)
    if not root.is_absolute() or ".." in root.parts:
        raise ScriptOutputPermissionError("selected script-output directory must be absolute and traversal-free")
    if (isinstance(max_directories, bool) or not isinstance(max_directories, int)
            or not 1 <= max_directories <= MAX_OUTPUT_DIRECTORIES):
        raise ScriptOutputPermissionError("script-output directory bound is invalid")
    if (isinstance(max_entries, bool) or not isinstance(max_entries, int)
            or not 1 <= max_entries <= MAX_OUTPUT_ENTRIES):
        raise ScriptOutputPermissionError("script-output entry bound is invalid")

    root_descriptor = _open_absolute_directory(root)
    records = []
    try:
        records = _walk_output_tree(
            root,
            root_descriptor,
            max_directories=max_directories,
            max_entries=max_entries,
        )
        # The walk owns the root descriptor too; the records list is complete
        # only after every path, ACL and ownership decision has been validated.
        operator_uid = os.getuid()
        plans = []
        for index, record in enumerate(records):
            descriptor = record["fd"]
            metadata = os.fstat(descriptor)
            label = str(record["path"])
            access_raw = _raw_acl(descriptor, _ACL_ACCESS, label=label)
            default_raw = _raw_acl(descriptor, _ACL_DEFAULT, label=label)
            access_entries = (_decode_acl(access_raw, label=label) if access_raw is not None else None)
            default_entries = (_decode_acl(default_raw, label=label) if default_raw is not None else None)
            if access_entries is None:
                # POSIX ACL absence means mode bits are the access ACL.
                mode = stat.S_IMODE(metadata.st_mode)
                access_entries = [
                    (_ACL_USER_OBJ, (mode >> 6) & 7, _ACL_UNDEFINED_ID),
                    (_ACL_GROUP_OBJ, (mode >> 3) & 7, _ACL_UNDEFINED_ID),
                    (_ACL_OTHER, mode & 7, _ACL_UNDEFINED_ID),
                ]

            if metadata.st_uid != operator_uid:
                if _foreign_directory_already_admitted(
                    metadata.st_uid, operator_uid, access_entries, default_entries
                ):
                    plans.append((index, access_raw, access_raw, default_raw, default_raw))
                    continue
                raise ScriptOutputPermissionError(
                    "script-output directory is not operator-owned and lacks complete runtime ACLs: " + label
                )

            access_new = _augment_acl(
                access_raw, operator_uid=operator_uid, runtime_uid=RUNTIME_UID,
                mode=stat.S_IMODE(metadata.st_mode), default=False,
            )
            default_new = _augment_acl(
                default_raw, operator_uid=operator_uid, runtime_uid=RUNTIME_UID,
                mode=stat.S_IMODE(metadata.st_mode), default=True,
            )
            plans.append((index, access_raw, access_new, default_raw, default_new))

        applied = []
        try:
            for index, access_old, access_new, default_old, default_new in plans:
                record = records[index]
                descriptor = record["fd"]
                _revalidate_linkage(records, index, root)
                for name, old, new in (
                    (_ACL_ACCESS, access_old, access_new),
                    (_ACL_DEFAULT, default_old, default_new),
                ):
                    if new == old:
                        continue
                    current = _raw_acl(descriptor, name, label=str(record["path"]))
                    if current != old:
                        raise ScriptOutputPermissionError(
                            "script-output ACL changed during admission: " + str(record["path"])
                        )
                    _write_acl(descriptor, name, new)
                    applied.append((descriptor, name, old, new, record["path"]))
                    os.fsync(descriptor)
        except BaseException as error:
            rollback_errors = []
            for descriptor, name, old, new, label in reversed(applied):
                try:
                    current = _raw_acl(descriptor, name, label=str(label))
                    if current != new:
                        rollback_errors.append(
                            str(label) + ": ACL changed during rollback; left untouched"
                        )
                        continue
                    _write_acl(descriptor, name, old)
                    os.fsync(descriptor)
                except (OSError, ScriptOutputPermissionError) as rollback_error:
                    rollback_errors.append(str(label) + ": " + str(rollback_error))
            if rollback_errors:
                raise ScriptOutputPermissionError(
                    "script-output ACL admission failed and rollback was incomplete: "
                    + "; ".join(rollback_errors)
                ) from error
            if isinstance(error, ScriptOutputPermissionError):
                raise
            raise ScriptOutputPermissionError("cannot update script-output ACLs: " + str(error)) from error
        return sum(access_old != access_new or default_old != default_new
                   for _index, access_old, access_new, default_old, default_new in plans)
    except ScriptOutputPermissionError:
        raise
    except OSError as error:
        raise ScriptOutputPermissionError("cannot validate script-output directory tree: " + str(error)) from error
    finally:
        # The root descriptor appears in records after a successful walk. On a
        # walk failure records may still be empty, so close it exactly once.
        descriptors = {record["fd"] for record in records}
        if root_descriptor not in descriptors:
            descriptors.add(root_descriptor)
        for descriptor in descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass
