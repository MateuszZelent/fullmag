"""Materialize and verify a stable native compiler-input directory.

The caller owns the native heavy-build and worktree locks. This helper mirrors
only a fully verified immutable source snapshot into the fixed
``<build-root>/compiler-inputs/source`` location. The binding preserves the
snapshot's provenance. An interrupted update is deliberately left unusable:
recovery requires an explicit operator action rather than an implicit reset.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fullmag_storage
from windows import build_snapshot, volatile_build_storage


SCHEMA = "fullmag.windows-compiler-inputs.v1"
BINDING_FIELDS = {"schema", "snapshot_id", "inventory_sha256", "record_path",
                  "source_root", "inventory"}


class CompilerInputsError(build_snapshot.SnapshotError):
    """A compiler-input mirror is missing, invalid, or unsafe to update."""


def _json_bytes(value):
    return build_snapshot._json_bytes(value)


def _sha(value):
    return hashlib.sha256(value).hexdigest()


def _lstat(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def _regular_file(path, label):
    build_snapshot._no_link(path)
    metadata = _lstat(path)
    if metadata is None or not stat.S_ISREG(metadata.st_mode):
        raise CompilerInputsError(f"{label} must be a regular file: {path}")
    return metadata


def _directory(path, label):
    build_snapshot._no_link(path)
    metadata = _lstat(path)
    if metadata is None or not stat.S_ISDIR(metadata.st_mode):
        raise CompilerInputsError(f"{label} must be a directory: {path}")
    return metadata


def _paths(build_root, working_root=None):
    build = build_snapshot._checked_root(build_root)
    if working_root is None:
        root = build / "compiler-inputs"
    else:
        try:
            # The working root is the helper's exact compiler_inputs_root;
            # callers cannot choose an arbitrary destination below it.
            root = volatile_build_storage.validate_working_root(build, working_root)
        except (fullmag_storage.StorageError, OSError, ValueError, TypeError) as error:
            raise CompilerInputsError(f"Compiler-input working root was refused: {error}") from error
    source = root / "source"
    binding = root / "record.json"
    build_snapshot._no_link(root)
    return build, root, source, binding


def _read_verified_record(record_path, build_root):
    """Fully verify a sealed snapshot before trusting its inventory or paths."""
    metadata = build_snapshot.verify_snapshot(record_path, build_root)
    path = Path(metadata["record_path"])
    _regular_file(path, "Snapshot record")
    try:
        _, raw = build_snapshot._read_regular_file_stable(path, "compiler-input snapshot record")
        record = json.loads(raw)
    except (OSError, ValueError, UnicodeError) as error:
        raise CompilerInputsError("Verified snapshot record could not be read") from error
    if raw != _json_bytes(record):
        raise CompilerInputsError("Verified snapshot record is not in canonical form")
    if not isinstance(record, dict) or record.get("snapshot_id") != metadata["snapshot_id"]:
        raise CompilerInputsError("Verified snapshot record changed while being read")
    if (record.get("inventory_sha256") != metadata["inventory_sha256"]
            or record.get("source_root") != metadata["source_root"]):
        raise CompilerInputsError("Verified snapshot inventory binding changed while being read")
    _validate_inventory(record.get("inventory"))
    if _sha(_json_bytes(record["inventory"])) != record["inventory_sha256"]:
        raise CompilerInputsError("Verified snapshot inventory digest mismatch")
    return metadata, record


def _validate_inventory(inventory):
    if not isinstance(inventory, list):
        raise CompilerInputsError("Compiler-input inventory must be a list")
    paths = []
    folded = set()
    for entry in inventory:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise CompilerInputsError("Invalid compiler-input inventory entry")
        relative = entry["path"]
        build_snapshot._relative(relative)
        if type(entry["size"]) is not int or entry["size"] < 0:
            raise CompilerInputsError("Invalid compiler-input file size")
        if not build_snapshot.HEX64.fullmatch(str(entry["sha256"])):
            raise CompilerInputsError("Invalid compiler-input file digest")
        folded_path = relative.casefold()
        if folded_path in folded:
            raise CompilerInputsError("Compiler-input paths collide on Windows")
        folded.add(folded_path)
        paths.append(relative)
    if paths != sorted(set(paths)):
        raise CompilerInputsError("Compiler-input inventory is unordered or duplicated")
    build_snapshot._reject_output_inputs(paths)


def _binding_value(metadata, record):
    return {
        "schema": SCHEMA,
        "snapshot_id": metadata["snapshot_id"],
        "inventory_sha256": metadata["inventory_sha256"],
        "record_path": metadata["record_path"],
        "source_root": metadata["source_root"],
        "inventory": record["inventory"],
    }


def _read_binding(root, binding_path, build_root, verified_record=None):
    """Validate the previous publication and prove its mirror before updates."""
    _directory(root, "Compiler-input root")
    _regular_file(binding_path, "Compiler-input binding")
    allowed = {"source", "record.json"}
    try:
        names = {item.name for item in root.iterdir()}
    except OSError as error:
        raise CompilerInputsError("Compiler-input root cannot be inventoried") from error
    if names != allowed:
        raise CompilerInputsError("Compiler-input root contains an unknown entry")

    try:
        _, raw = build_snapshot._read_regular_file_stable(binding_path, "compiler-input binding")
        value = json.loads(raw)
    except (OSError, ValueError, UnicodeError) as error:
        raise CompilerInputsError("Compiler-input binding is unavailable or invalid") from error
    if not isinstance(value, dict) or set(value) != BINDING_FIELDS or value.get("schema") != SCHEMA:
        raise CompilerInputsError("Compiler-input binding schema mismatch")
    if raw != _json_bytes(value):
        raise CompilerInputsError("Compiler-input binding is not in canonical form")
    for key in ("snapshot_id", "inventory_sha256", "record_path", "source_root"):
        if not isinstance(value[key], str):
            raise CompilerInputsError(f"Invalid compiler-input binding field: {key}")
    if not build_snapshot.HEX64.fullmatch(value["snapshot_id"]):
        raise CompilerInputsError("Invalid compiler-input snapshot id")
    _validate_inventory(value["inventory"])
    if not isinstance(value["inventory_sha256"], str) or not build_snapshot.HEX64.fullmatch(value["inventory_sha256"]):
        raise CompilerInputsError("Invalid compiler-input binding digest")
    if _sha(_json_bytes(value["inventory"])) != value["inventory_sha256"]:
        raise CompilerInputsError("Compiler-input binding inventory digest mismatch")

    if (verified_record is not None
            and value["record_path"] == verified_record[0]["record_path"]):
        old_metadata, old_record = verified_record
    else:
        old_metadata, old_record = _read_verified_record(value["record_path"], build_root)
    expected = _binding_value(old_metadata, old_record)
    if value != expected:
        raise CompilerInputsError("Compiler-input binding differs from its sealed snapshot")
    source = root / "source"
    _directory(source, "Compiler-input source root")
    _verify_tree(source, value["inventory"])
    return value, old_metadata


def _verify_tree(source, inventory):
    """Check the mirror's exact frozen byte inventory plus bounded Tauri outputs."""
    _directory(source, "Compiler-input source root")
    expected = {entry["path"]: entry for entry in inventory}
    actual = []

    def walk_error(error):
        raise CompilerInputsError("Compiler-input tree cannot be fully inventoried") from error

    for directory, folders, files in os.walk(source, topdown=True, followlinks=False, onerror=walk_error):
        directory_path = Path(directory)
        for name in folders:
            child = directory_path / name
            build_snapshot._no_link(child)
            metadata = _lstat(child)
            if metadata is None or not stat.S_ISDIR(metadata.st_mode):
                raise CompilerInputsError("Compiler-input tree contains a non-directory path")
            relative = child.relative_to(source).as_posix()
            if relative.startswith(build_snapshot.TAURI_OUTPUT_DIRECTORY + "/"):
                raise CompilerInputsError("Tauri generated-output directory cannot contain subdirectories")
        for name in files:
            child = directory_path / name
            relative = child.relative_to(source).as_posix()
            if build_snapshot._validate_generated_output(child, relative):
                continue
            entry, _ = build_snapshot._file_entry(child, relative)
            actual.append(entry)

    actual.sort(key=lambda item: item["path"])
    if actual != inventory:
        actual_map = {entry["path"]: entry for entry in actual}
        for entry in actual:
            if entry["path"] not in expected:
                raise CompilerInputsError(f"Compiler-input tree contains an unknown file: {entry['path']}")
        if set(actual_map) != set(expected):
            raise CompilerInputsError("Compiler-input tree does not match the pinned snapshot inventory")
        raise CompilerInputsError("Compiler-input file bytes differ from the pinned snapshot")


def _ensure_directory(root, relative):
    current = root
    for part in Path(relative).parts:
        current = current / part
        metadata = _lstat(current)
        if metadata is None:
            current.mkdir()
            metadata = _lstat(current)
        build_snapshot._no_link(current)
        if metadata is None or not stat.S_ISDIR(metadata.st_mode):
            raise CompilerInputsError(f"Compiler-input parent is not a directory: {current}")
        build_snapshot._checked_child(root, current.relative_to(root).as_posix())


def _sync_file(path):
    _regular_file(path, "Compiler-input file")
    try:
        with path.open("r+b") as stream:
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise CompilerInputsError(f"Compiler-input file could not be synchronized: {path}") from error


def _sync_directory(path):
    # Directory fsync is available on POSIX. Windows flushes each file before
    # the atomic rename; its standard library does not expose a portable
    # directory-handle flush.
    if os.name == "nt":
        return
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise CompilerInputsError(f"Compiler-input directory could not be synchronized: {path}") from error


def _replace_from_snapshot(source_root, source_file, destination, expected):
    parent = destination.parent
    temporary = parent / f".compiler-input-{uuid.uuid4().hex}.tmp"
    build_snapshot._checked_child(source_root, destination.relative_to(source_root).as_posix())
    build_snapshot._checked_child(source_root, temporary.relative_to(source_root).as_posix())
    # The temporary file is deliberately left behind if an operation is
    # interrupted; the next validation rejects it and requires explicit repair.
    copied = build_snapshot._copy_file(source_file, temporary)
    if copied["size"] != expected["size"] or copied["sha256"] != expected["sha256"]:
        raise CompilerInputsError(f"Snapshot bytes changed during materialization: {expected['path']}")
    _sync_file(temporary)
    build_snapshot._no_link(parent)
    if not parent.is_dir():
        raise CompilerInputsError(f"Compiler-input parent changed during materialization: {parent}")
    build_snapshot._no_link(destination)
    os.replace(temporary, destination)
    _regular_file(destination, "Materialized compiler input")
    result, _ = build_snapshot._file_entry(destination, expected["path"])
    if result != expected:
        raise CompilerInputsError(f"Materialized compiler input failed verification: {expected['path']}")
    _sync_file(destination)
    _sync_directory(parent)


def _publish_binding(root, binding_path, value):
    temporary = root / f".record.json.tmp-{uuid.uuid4().hex}"
    raw = _json_bytes(value)
    try:
        with temporary.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        _regular_file(temporary, "Temporary compiler-input binding")
        build_snapshot._no_link(root)
        os.replace(temporary, binding_path)
        _regular_file(binding_path, "Compiler-input binding")
        _sync_directory(root)
    except OSError as error:
        raise CompilerInputsError("Compiler-input binding could not be published atomically") from error


def _read_published_binding(root, binding_path, value):
    """Read back only the small atomic binding after its inventory was proven."""
    _directory(root, "Compiler-input root")
    try:
        names = {item.name for item in root.iterdir()}
    except OSError as error:
        raise CompilerInputsError("Published compiler-input root cannot be inventoried") from error
    if names != {"source", "record.json"}:
        raise CompilerInputsError("Published compiler-input root contains an unknown entry")
    _directory(root / "source", "Compiler-input source root")
    _regular_file(binding_path, "Published compiler-input binding")
    try:
        _, raw = build_snapshot._read_regular_file_stable(binding_path, "published compiler-input binding")
    except OSError as error:
        raise CompilerInputsError("Published compiler-input binding could not be read back") from error
    if raw != _json_bytes(value):
        raise CompilerInputsError("Published compiler-input binding differs from its verified value")


def _result(metadata, source, binding_path):
    result = dict(metadata)
    result["snapshot_source_root"] = result["source_root"]
    result["source_root"] = str(source)
    result["compiler_input_binding"] = str(binding_path)
    return result


def verify(record_path, build_root, *, working_root=None):
    """Verify a published mirror against the requested immutable snapshot."""
    metadata, record = _read_verified_record(record_path, build_root)
    build, root, source, binding_path = _paths(build_root, working_root)
    if _lstat(root) is None:
        raise CompilerInputsError("Compiler-input mirror has not been materialized")
    value, _ = _read_binding(root, binding_path, build, verified_record=(metadata, record))
    if value != _binding_value(metadata, record):
        raise CompilerInputsError("Compiler-input mirror is bound to a different snapshot")
    return _result(metadata, source, binding_path)


def materialize(record_path, build_root, *, working_root=None):
    """Materialize or update the one fixed compiler-input mirror.

    The requested source snapshot is fully verified before any mirror write.
    Existing mirrors must have a valid binding and match their prior snapshot;
    partial/interrupted state is never silently reset. The caller owns all
    worktree and native heavy-build locks.
    """
    metadata, record = _read_verified_record(record_path, build_root)
    build, root, source, binding_path = _paths(build_root, working_root)
    root_metadata = _lstat(root)
    previous = None
    previous_inventory = {}

    if root_metadata is None:
        root.mkdir()
        _directory(root, "Compiler-input root")
        source.mkdir()
        _directory(source, "Compiler-input source root")
    else:
        _directory(root, "Compiler-input root")
        # A pre-existing unbound tree, including an empty one, is not ours.
        if _lstat(binding_path) is None:
            raise CompilerInputsError("Existing compiler-input root has no valid ownership binding")
        previous, _ = _read_binding(root, binding_path, build, verified_record=(metadata, record))
        previous_inventory = {entry["path"]: entry for entry in previous["inventory"]}

    old_paths = set(previous_inventory)
    new_inventory = record["inventory"]
    new_paths = {entry["path"] for entry in new_inventory}
    for path in new_paths:
        if any(old.startswith(path + "/") for old in old_paths):
            raise CompilerInputsError("File-to-directory transitions require explicit mirror recovery")

    snapshot_source = Path(metadata["source_root"])
    # Preflight every source and destination chain before the first mutation.
    source_files = {}
    for entry in new_inventory:
        source_file = build_snapshot._checked_child(snapshot_source, entry["path"])
        source_entry, _ = build_snapshot._file_entry(source_file, entry["path"])
        if source_entry != entry:
            raise CompilerInputsError(f"Snapshot input changed after verification: {entry['path']}")
        source_files[entry["path"]] = source_file
        destination = build_snapshot._checked_child(source, entry["path"])
        for parent in reversed(destination.parents):
            if parent == source or source in parent.parents:
                build_snapshot._no_link(parent)
                parent_metadata = _lstat(parent)
                if parent_metadata is not None and not stat.S_ISDIR(parent_metadata.st_mode):
                    if parent.relative_to(source).as_posix() not in old_paths:
                        raise CompilerInputsError("Compiler-input path is blocked by an unowned file")
        existing = _lstat(destination)
        if existing is not None:
            build_snapshot._no_link(destination)
            if not stat.S_ISREG(existing.st_mode) or entry["path"] not in old_paths:
                raise CompilerInputsError("Compiler-input destination is not a previously owned regular file")

    # Remove only exact regular files named in the prior verified binding.
    # Directories, build caches, target trees, and unrelated files are never
    # recursively removed or traversed as cleanup targets.
    for relative in sorted(old_paths - new_paths):
        stale = build_snapshot._checked_child(source, relative)
        _regular_file(stale, "Previously owned stale compiler input")
        stale.unlink()
        _sync_directory(stale.parent)

    for entry in new_inventory:
        destination = build_snapshot._checked_child(source, entry["path"])
        _ensure_directory(source, Path(entry["path"]).parent.as_posix()
                          if Path(entry["path"]).parent != Path(".") else "")
        current = _lstat(destination)
        if current is not None:
            _regular_file(destination, "Existing compiler input")
            actual, _ = build_snapshot._file_entry(destination, entry["path"])
            if actual == entry:
                continue  # Preserve mtime for byte-identical inputs.
        _replace_from_snapshot(source, source_files[entry["path"]], destination, entry)

    _verify_tree(source, new_inventory)
    value = _binding_value(metadata, record)
    _publish_binding(root, binding_path, value)
    _read_published_binding(root, binding_path, value)
    return _result(metadata, source, binding_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("materialize", "verify"):
        child = commands.add_parser(command)
        child.add_argument("--record", required=True, type=Path)
        child.add_argument("--build-root", required=True, type=Path)
        child.add_argument("--working-root", type=Path)
    args = parser.parse_args()
    try:
        result = (materialize(args.record, args.build_root, working_root=args.working_root)
                  if args.command == "materialize"
                  else verify(args.record, args.build_root, working_root=args.working_root))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (build_snapshot.SnapshotError, build_snapshot.SourceIdentityError,
            fullmag_storage.StorageError, OSError, ValueError) as error:
        print(f"WINDOWS_COMPILER_INPUTS_ERROR={error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
