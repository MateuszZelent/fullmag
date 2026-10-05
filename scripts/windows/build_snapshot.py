"""Freeze raw native-build inputs while retaining the origin Git provenance.

The caller owns storage/profile/heavy locks. Verification uses only this sealed
inventory, never the current Git index or dirty checkout. Four SDK-generated
Tauri JSON outputs are bounded/validated but are not frozen source evidence.
This is source integrity evidence, not runtime or scientific qualification.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import copy
from contextvars import ContextVar
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import subprocess
import sys
import threading
import time
import uuid

if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class _FileTime(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    _set_file_time = ctypes.WinDLL("kernel32", use_last_error=True).SetFileTime
    _set_file_time.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                              ctypes.POINTER(_FileTime), ctypes.POINTER(_FileTime)]
    _set_file_time.restype = wintypes.BOOL

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capture_source_snapshot_identity import (
    EXCLUDED_COMMITTED_SOURCE_PATHS,
    SourceIdentityError, _is_non_runtime_path, _read_regular_file_stable, capture,
)
from fullmag_storage import identifier
from windows.workspace_backend_identity import DEPENDENCY_INPUTS, INPUTS, fingerprint

SCHEMA = "fullmag.windows-build-snapshot.v1"
HEX64 = re.compile(r"[0-9a-f]{64}")
EXCLUDED = EXCLUDED_COMMITTED_SOURCE_PATHS | {
    ".git", "storage", "worktrees", "node_modules", "target", "Codex-Usage",
    ".fullmag-build", ".fullmag-cache", ".fullmag-cargo", ".fullmag-rustup", ".impl-racetrack",
}
CORE_FIELDS = {"schema", "origin_repo_root", "origin_worktree_id", "source_identity",
               "backend_source_sha256", "dependency_source_sha256", "inventory_sha256",
               "inventory", "backend_input_paths", "dependency_input_paths", "generated_output_policy"}
LOCATION_FIELDS = {"snapshot_id", "record_path", "source_root", "source_identity_file"}
TAURI_OUTPUT_DIRECTORY = "apps/desktop/src-tauri/gen/schemas"
TAURI_OUTPUT_NAMES = frozenset({"acl-manifests.json", "capabilities.json", "desktop-schema.json", "windows-schema.json"})
GENERATED_OUTPUT_POLICY = {
    "directory": TAURI_OUTPUT_DIRECTORY, "filenames": sorted(TAURI_OUTPUT_NAMES),
    "maximum_file_bytes": 8 * 1024 * 1024,
    "integrity": "compiler_outputs_not_frozen_source",
}


class SnapshotError(RuntimeError):
    pass


class SourceChangedSnapshot(SnapshotError):
    """The live checkout changed during the short source-copy phase."""


_SNAPSHOT_VERIFICATION_CACHE = ContextVar("fullmag_snapshot_verification_cache", default=None)


@contextmanager
def snapshot_verification_scope():
    """Reuse checks within one operation; force a full final check before ACK.

    Record/path validation on a hit is not proof of unchanged source bytes.
    Callers must force fresh verification before publishing a dependent result.
    """
    token = _SNAPSHOT_VERIFICATION_CACHE.set((threading.current_thread(), {}))
    try:
        yield
    finally:
        _SNAPSHOT_VERIFICATION_CACHE.reset(token)


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _sha(value):
    return hashlib.sha256(value).hexdigest()


def _relative(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise SnapshotError("Invalid source inventory path")
    posix, windows = PurePosixPath(value), PureWindowsPath(value)
    if posix.is_absolute() or windows.anchor or any(part in {"", ".", ".."} for part in value.split("/")):
        raise SnapshotError("Source inventory path is not a canonical relative path")
    return Path(*posix.parts)


def _no_link(path):
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
        raise SnapshotError(f"Source snapshots cannot traverse symlinks/reparse points: {path}")


def _checked_root(value):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise SnapshotError("Snapshot roots must be absolute canonical paths")
    for ancestor in reversed((path, *path.parents)):
        _no_link(ancestor)
    if os.path.normcase(str(path.absolute())) != os.path.normcase(str(path.resolve())):
        raise SnapshotError("Snapshot root is not canonical")
    if not path.is_dir():
        raise SnapshotError("Snapshot root must already be a directory")
    return path.resolve()


def _checked_child(root, relative):
    path = root / _relative(relative)
    for ancestor in reversed((path, *path.parents)):
        if ancestor == root or root in ancestor.parents:
            _no_link(ancestor)
    if root not in path.resolve().parents:
        raise SnapshotError("Snapshot path escapes its root")
    return path


def _git(repo, *arguments):
    try:
        return subprocess.check_output(["git", "-C", str(repo), *arguments], stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        raise SnapshotError("Cannot inventory the origin Git checkout") from error


def _paths(repo, inputs=()):
    raw = _git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *inputs)
    return sorted({entry.decode("utf-8") for entry in raw.split(b"\0") if entry})


def _gitlinks(repo):
    links = set()
    for entry in _git(repo, "ls-files", "--stage", "-z").split(b"\0"):
        if entry.startswith(b"160000 "):
            relative = entry.split(b"\t", 1)[1].decode("utf-8")
            _relative(relative)
            if any(relative == item or relative.startswith(item + "/") or item.startswith(relative + "/") for item in INPUTS):
                raise SnapshotError("A native source input is an unsupported Git submodule")
            links.add(relative)
    return links


def _excluded(relative, links):
    return any(relative == item or relative.startswith(item + "/") for item in EXCLUDED | links)


def _reject_output_inputs(paths):
    if any(path == TAURI_OUTPUT_DIRECTORY or path.startswith(TAURI_OUTPUT_DIRECTORY + "/") for path in paths):
        raise SnapshotError("Tauri generated-output directory contains a tracked/nonignored source input")


def _validate_generated_output(path, relative):
    prefix = TAURI_OUTPUT_DIRECTORY + "/"
    if not relative.startswith(prefix):
        return False
    if relative[len(prefix):] not in TAURI_OUTPUT_NAMES:
        raise SnapshotError("Unknown file in Tauri generated-output directory")
    _no_link(path)
    if path.lstat().st_size > GENERATED_OUTPUT_POLICY["maximum_file_bytes"]:
        raise SnapshotError("Tauri generated JSON exceeds its output limit")
    _, content = _file_entry(path, relative)
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError) as error:
        raise SnapshotError("Tauri generated output must be valid JSON") from error
    if not isinstance(value, dict):
        raise SnapshotError("Tauri generated output must be a JSON object")
    return True


def _file_entry(path, relative):
    _no_link(path)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise SnapshotError(f"Source input must be a regular file: {relative}")
    metadata, content = _read_regular_file_stable(path, f"snapshot input {relative}")
    return {"path": relative, "size": metadata.st_size, "sha256": _sha(content)}, content


def _inventory(repo, paths):
    result = []
    for relative in paths:
        path = _checked_child(repo, relative)
        if not path.exists():
            continue  # Tracked deletions remain bound by the Git source identity.
        entry, _ = _file_entry(path, relative)
        result.append(entry)
    return result


def _copy_file(source, destination):
    _no_link(source)
    if not stat.S_ISREG(source.lstat().st_mode):
        raise SnapshotError(f"Source input must be a regular file: {source.name}")
    metadata, content = _read_regular_file_stable(source, "snapshot source")
    entry = {"path": source.name, "size": metadata.st_size, "sha256": _sha(content)}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as stream:
        stream.write(content)
        stream.flush()
        # Keep the exact opened destination: Windows does not support utime
        # with follow_symlinks=False, and a path fallback could follow a link.
        if os.name == "nt":
            def file_time(nanoseconds):
                ticks = nanoseconds // 100 + 116444736000000000
                if not 0 <= ticks < 2**64:
                    raise SnapshotError("Source timestamp is outside the Windows FILETIME range")
                return _FileTime(ticks & 0xffffffff, ticks >> 32)

            accessed = file_time(metadata.st_atime_ns)
            modified = file_time(metadata.st_mtime_ns)
            if not _set_file_time(msvcrt.get_osfhandle(stream.fileno()), None,
                                  ctypes.byref(accessed), ctypes.byref(modified)):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            os.utime(stream.fileno(), ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
    return entry


def _input_digest(paths, entries):
    inventory = {entry["path"]: entry for entry in entries}
    digest = hashlib.sha256()
    for relative in paths:
        _relative(relative)
        digest.update(relative.encode() + b"\0")
        digest.update(bytes.fromhex(inventory[relative]["sha256"]) if relative in inventory else b"deleted")
    return digest.hexdigest()


def _validate_identity(identity):
    if not isinstance(identity, dict) or identity.get("schema") != "fullmag.source-snapshot.v2":
        raise SnapshotError("Invalid captured Git source identity")
    if not re.fullmatch(r"[0-9a-f]{40}", str(identity.get("head_commit_full", ""))):
        raise SnapshotError("Invalid origin commit")
    derived = {"source_snapshot_dirty", "dirty_content_sha256", "source_snapshot_sha256"}
    payload = {key: value for key, value in identity.items() if key not in derived}
    if (identity.get("source_snapshot_sha256") != _sha(_json_bytes(payload))
            or identity.get("dirty_content_sha256") != _sha(_json_bytes(identity.get("dirty_path_content")))
            or type(identity.get("source_snapshot_dirty")) is not bool
            or identity["source_snapshot_dirty"] != bool(identity.get("git_status_porcelain_v1"))):
        raise SnapshotError("Captured Git source identity integrity mismatch")


def _metadata(record):
    return {key: value for key, value in record.items()
            if key not in {"inventory", "backend_input_paths", "dependency_input_paths"}}


def _verify_snapshot_full(record, build_root):
    """Check only frozen files and pinned provenance; origin may already differ."""
    build = _checked_root(build_root)
    supplied = record if isinstance(record, dict) else None
    path = Path(supplied["record_path"] if supplied else record)
    if not path.is_absolute() or build not in path.parents:
        raise SnapshotError("Snapshot record must be below the canonical build root")
    _checked_child(build, path.relative_to(build).as_posix())
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError) as error:
        raise SnapshotError("Snapshot record is unavailable or invalid") from error
    if not isinstance(value, dict) or set(value) != CORE_FIELDS | LOCATION_FIELDS or value["schema"] != SCHEMA:
        raise SnapshotError("Snapshot record schema mismatch")
    core = {key: value[key] for key in CORE_FIELDS}
    if value["generated_output_policy"] != GENERATED_OUTPUT_POLICY:
        raise SnapshotError("Unknown generated-output exception policy")
    snapshot_id = _sha(_json_bytes(core))
    base = build / "source-snapshots" / snapshot_id
    expected_locations = {"snapshot_id": snapshot_id, "record_path": str(base / "record.json"),
                          "source_root": str(base / "source"), "source_identity_file": str(base / "source-identity.json")}
    if any(value[key] != expected for key, expected in expected_locations.items()) or path != base / "record.json":
        raise SnapshotError("Snapshot record provenance/location integrity mismatch")
    origin = value["origin_repo_root"]
    if not isinstance(origin, str) or not Path(origin).is_absolute() or value["origin_worktree_id"] != identifier(origin):
        raise SnapshotError("Invalid origin checkout pin")
    _validate_identity(value["source_identity"])
    identity_file = _checked_child(build, (base / "source-identity.json").relative_to(build).as_posix())
    if identity_file.read_bytes() != _json_bytes(value["source_identity"]):
        raise SnapshotError("Snapshot source identity file changed")
    source = _checked_root(base / "source")
    recorded = value["inventory"]
    if not isinstance(recorded, list) or value["inventory_sha256"] != _sha(_json_bytes(recorded)):
        raise SnapshotError("Snapshot inventory integrity mismatch")
    paths = []
    for entry in recorded:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise SnapshotError("Invalid snapshot inventory entry")
        _relative(entry["path"])
        if type(entry["size"]) is not int or entry["size"] < 0 or not HEX64.fullmatch(str(entry["sha256"])):
            raise SnapshotError("Invalid snapshot file identity")
        paths.append(entry["path"])
    if paths != sorted(set(paths)):
        raise SnapshotError("Snapshot inventory contains duplicate/unordered paths")
    _reject_output_inputs(paths)
    actual_paths = []
    def walk_error(error):
        raise SnapshotError("Frozen source directory cannot be fully inventoried") from error
    for directory, folders, files in os.walk(source, followlinks=False, onerror=walk_error):
        for name in folders + files:
            _no_link(Path(directory) / name)
        for name in folders:
            relative = (Path(directory) / name).relative_to(source).as_posix()
            if relative.startswith(TAURI_OUTPUT_DIRECTORY + "/"):
                raise SnapshotError("Tauri generated-output directory cannot contain subdirectories")
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(source).as_posix()
            if not _validate_generated_output(path, relative):
                actual_paths.append(relative)
    if sorted(actual_paths) != paths or _inventory(source, paths) != recorded:
        raise SnapshotError("Frozen source changed or contains unrecorded files")
    for label in ("backend", "dependency"):
        inputs = value[f"{label}_input_paths"]
        if not isinstance(inputs, list) or inputs != sorted(set(inputs)):
            raise SnapshotError("Invalid snapshot fingerprint input inventory")
        _reject_output_inputs(inputs)
        if _input_digest(inputs, recorded) != value[f"{label}_source_sha256"]:
            raise SnapshotError("Frozen fingerprint differs from captured request inputs")
    metadata = _metadata(value)
    if supplied is not None and supplied != metadata:
        raise SnapshotError("Supplied snapshot metadata differs from its sealed record")
    return metadata


def _stable_record_bytes(path):
    try:
        _, raw = _read_regular_file_stable(path, "frozen source snapshot record")
        return raw
    except (OSError, SourceIdentityError) as error:
        raise SnapshotError("Snapshot record is unavailable or changed") from error


def _validate_cached_paths(build, path, metadata):
    if os.path.normcase(str(Path(metadata["record_path"]))) != os.path.normcase(str(path)):
        raise SnapshotError("Cached snapshot record path differs from its verified location")
    source = Path(metadata["source_root"])
    checked_source = _checked_root(source)
    if os.path.normcase(str(checked_source)) != os.path.normcase(str(source)):
        raise SnapshotError("Cached snapshot source root is not canonical")
    identity = Path(metadata["source_identity_file"])
    if not identity.is_absolute() or build not in identity.parents:
        raise SnapshotError("Cached snapshot identity file is outside the build root")
    identity = _checked_child(build, identity.relative_to(build).as_posix())
    try:
        identity_metadata = identity.lstat()
    except OSError as error:
        raise SnapshotError("Cached snapshot identity file is unavailable") from error
    if not stat.S_ISREG(identity_metadata.st_mode):
        raise SnapshotError("Cached snapshot identity file is not regular")


def verify_snapshot(record, build_root, *, force_verify=False):
    """Verify a frozen snapshot, reusing only exact records in an active scope.

    Calls outside ``snapshot_verification_scope`` retain full verification.
    Within a scope, cache hits still validate the canonical roots and record
    paths; callers can force a fresh inventory pass with ``force_verify=True``.
    """
    if type(force_verify) is not bool:
        raise SnapshotError("force_verify must be a boolean")
    cache_state = _SNAPSHOT_VERIFICATION_CACHE.get()
    if cache_state is None or cache_state[0] is not threading.current_thread():
        return _verify_snapshot_full(record, build_root)
    cache = cache_state[1]

    build = _checked_root(build_root)
    supplied = record if isinstance(record, dict) else None
    path = Path(supplied["record_path"] if supplied else record)
    if not path.is_absolute() or build not in path.parents:
        raise SnapshotError("Snapshot record must be below the canonical build root")
    _checked_child(build, path.relative_to(build).as_posix())
    key = (os.path.normcase(str(build)), os.path.normcase(str(path)))
    if force_verify:
        cache.pop(key, None)
    try:
        raw_before = _stable_record_bytes(path)
    except Exception:
        cache.pop(key, None)
        raise

    raw_sha256 = _sha(raw_before)
    cached = cache.get(key)
    if not force_verify and cached is not None:
        cached_sha256, cached_raw, cached_metadata = cached
        if cached_sha256 == raw_sha256 and cached_raw == raw_before:
            try:
                _validate_cached_paths(build, path, cached_metadata)
            except Exception:
                cache.pop(key, None)
                raise
            if supplied is not None and supplied != cached_metadata:
                raise SnapshotError("Supplied snapshot metadata differs from its sealed record")
            return copy.deepcopy(cached_metadata)
        cache.pop(key, None)

    try:
        metadata = _verify_snapshot_full(record, build_root)
        raw_after = _stable_record_bytes(path)
        if raw_after != raw_before:
            raise SnapshotError("Snapshot record changed during verification")
    except Exception:
        cache.pop(key, None)
        raise
    cache[key] = (raw_sha256, raw_before, copy.deepcopy(metadata))
    return copy.deepcopy(metadata)


def create_snapshot(repo_root, build_root):
    """Capture under caller-owned managed locks; never overwrite frozen sources."""
    repo, build = _checked_root(repo_root), _checked_root(build_root)
    if repo == build or repo in build.parents or build in repo.parents:
        raise SnapshotError("Build snapshots must be outside the origin checkout")
    if Path(_git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve() != repo:
        raise SnapshotError("Origin must be the Git checkout root")
    links = _gitlinks(repo)
    paths = [path for path in _paths(repo) if not _excluded(path, links)]
    _reject_output_inputs(paths)
    entries = _inventory(repo, paths)
    # Validate all copied paths before any fingerprint can follow an origin link.
    identity = capture(repo, ignore_non_runtime_dirty=True)
    backend = fingerprint(repo)["sha256"]
    dependencies = fingerprint(repo, DEPENDENCY_INPUTS)["sha256"]
    backend_paths, dependency_paths = _paths(repo, INPUTS), _paths(repo, DEPENDENCY_INPUTS)
    protected_paths = set(backend_paths) | set(dependency_paths) | {
        path for path in paths if not _is_non_runtime_path(path)
    }
    protected_entries = [entry for entry in entries if entry["path"] in protected_paths]
    core = dict(schema=SCHEMA, origin_repo_root=str(repo), origin_worktree_id=identifier(repo),
                source_identity=identity, backend_source_sha256=backend,
                dependency_source_sha256=dependencies, inventory_sha256=_sha(_json_bytes(entries)),
                inventory=entries, backend_input_paths=backend_paths, dependency_input_paths=dependency_paths,
                generated_output_policy=GENERATED_OUTPUT_POLICY)
    if _input_digest(backend_paths, entries) != backend or _input_digest(dependency_paths, entries) != dependencies:
        raise SourceChangedSnapshot("Source inventory differs from request fingerprints")
    snapshots = _checked_child(build, "source-snapshots")
    snapshots.mkdir(exist_ok=True)
    snapshot_id = _sha(_json_bytes(core))
    final = _checked_child(build, f"source-snapshots/{snapshot_id}")
    def confirm_origin():
        if (capture(repo, ignore_non_runtime_dirty=True) != identity
                or fingerprint(repo)["sha256"] != backend
                or fingerprint(repo, DEPENDENCY_INPUTS)["sha256"] != dependencies
                or _gitlinks(repo) != links
                or _inventory(repo, sorted(protected_paths)) != protected_entries):
            raise SourceChangedSnapshot("Origin changed during source snapshot capture")
    if final.exists():
        confirm_origin()
        return verify_snapshot(final / "record.json", build)
    staging = _checked_child(build, "source-snapshots/.capture-" + uuid.uuid4().hex)
    staging.mkdir()
    source = staging / "source"
    source.mkdir()
    copied_entries = []
    for expected in entries:
        copied = _copy_file(_checked_child(repo, expected["path"]), _checked_child(source, expected["path"]))
        if expected["path"] in protected_paths and (copied["sha256"] != expected["sha256"] or copied["size"] != expected["size"]):
            raise SourceChangedSnapshot("Origin changed while copying a source file")
        copied_entries.append({**copied, "path": expected["path"]})
    confirm_origin()
    # Browser HMR/docs may keep moving during capture. Record their ACTUAL
    # copied bytes, independently of the unchanged protected native inputs.
    # Subsequent snapshot verification still checks every copied file.
    core["inventory"] = copied_entries
    core["inventory_sha256"] = _sha(_json_bytes(copied_entries))
    snapshot_id = _sha(_json_bytes(core))
    final = _checked_child(build, f"source-snapshots/{snapshot_id}")
    record = dict(core, snapshot_id=snapshot_id, record_path=str(final / "record.json"),
                  source_root=str(final / "source"), source_identity_file=str(final / "source-identity.json"))
    (staging / "source-identity.json").write_bytes(_json_bytes(identity))
    (staging / "record.json").write_bytes(_json_bytes(record))
    # The caller's build lock serializes publication; an existing snapshot is never replaced.
    if final.exists():
        raise SnapshotError("Snapshot appeared during publication; refusing overwrite")
    staging.rename(final)
    metadata = verify_snapshot(final / "record.json", build)
    for relative in ("record.json", "source-identity.json", *("source/" + entry["path"] for entry in entries)):
        _checked_child(final, relative).chmod(0o444)
    return metadata


def capture_for_build(repo_root, build_root, attempts=3):
    """Retry only capture races; compilation and integrity failures never loop."""
    for attempt in range(attempts):
        try:
            return create_snapshot(repo_root, build_root)
        except SourceIdentityError as error:
            if str(error) != "source identity changed while capturing the snapshot":
                raise
            if attempt + 1 == attempts:
                raise
        except SourceChangedSnapshot:
            if attempt + 1 == attempts:
                raise
        time.sleep(0.25)
    raise SnapshotError("A positive capture attempt count is required")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--repo-root", required=True, type=Path)
    create.add_argument("--build-root", required=True, type=Path)
    verify = commands.add_parser("verify")
    verify.add_argument("--record", required=True, type=Path)
    verify.add_argument("--build-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = (capture_for_build(args.repo_root, args.build_root) if args.command == "create"
                  else verify_snapshot(args.record, args.build_root))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (SnapshotError, SourceIdentityError, OSError, ValueError) as error:
        print(f"WINDOWS_BUILD_SNAPSHOT_ERROR={error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
