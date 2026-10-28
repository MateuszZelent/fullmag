"""Validation and receipts for a separately pinned Docker DEV helper checkout."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys

from docker_dev_host import validate_host_path


SCHEMA = "fullmag.docker-helper-source-binding.v1"
_IMAGE_LABEL_PREFIX = "org.fullmag.helper-source."
_IMAGE_LABELS = {
    "schema": _IMAGE_LABEL_PREFIX + "schema",
    "commit": _IMAGE_LABEL_PREFIX + "commit",
    "manifest_sha256": _IMAGE_LABEL_PREFIX + "manifest-sha256",
    "docker_startup_script_sha256": _IMAGE_LABEL_PREFIX + "docker-startup-script-sha256",
    "fullmag_storage_sha256": _IMAGE_LABEL_PREFIX + "fullmag-storage-sha256",
}
_SHA1 = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MAX_FILE_BYTES = 16 * 1024 * 1024
_MAX_MANIFEST_BYTES = 256 * 1024 * 1024

# These files form the host-side recreation/import surface. The runtime image
# inventories are added by the caller so their exact BuildKit inputs are pinned
# by the same manifest as the CLI and Compose definition.
PRODUCTION_LAUNCHER_FILES = (
    "scripts/docker_dev.py",
    "scripts/docker_volume_dev.py",
    "scripts/docker_build_control.py",
    "scripts/docker_helper_source.py",
    "scripts/docker_dev_host.py",
    "scripts/docker_development_inputs.py",
    "scripts/docker_compose_identity.py",
    "scripts/docker_backend_inputs.py",
    "scripts/bootstrap_docker_toolchain.py",
    "scripts/fullmag_docker_runtime.py",
    "scripts/docker_startup_script.py",
    "scripts/fullmag_storage.py",
    "scripts/windows_folder_host.py",
    "scripts/linux_native_host.py",
)
_EXECUTED_MODULES = {
    "scripts/docker_dev.py": "docker_dev",
    "scripts/docker_volume_dev.py": "docker_volume_dev",
    "scripts/docker_build_control.py": "docker_build_control",
    "scripts/docker_helper_source.py": "docker_helper_source",
    "scripts/docker_dev_host.py": "docker_dev_host",
}


class HelperSourceError(ValueError):
    """The requested helper checkout cannot be bound safely."""


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def validate_option_pair(root, commit):
    """Validate the optional CLI pair without touching the selected app checkout."""
    if root is None and commit is None:
        return None
    if root is None or commit is None:
        raise HelperSourceError("--helper-source-root and --helper-source-commit must be supplied together")
    path = Path(root)
    if not path.is_absolute() or ".." in path.parts:
        raise HelperSourceError("--helper-source-root must be an absolute path without parent traversal")
    if not isinstance(commit, str) or not _SHA1.fullmatch(commit):
        raise HelperSourceError("--helper-source-commit must be a full lowercase SHA-1 commit")
    return path, commit


def _git(root, *arguments, data=None):
    environment = dict(os.environ)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()[-2048:]
        raise HelperSourceError("Pinned helper Git query failed: " + (detail or "unknown error"))
    return result.stdout


def _common_git_directory(root):
    raw = _git(root, "rev-parse", "--git-common-dir").decode("utf-8", "strict").strip()
    path = Path(raw)
    return (path if path.is_absolute() else root / path).resolve(strict=True)


def _relative_path(value):
    if (not isinstance(value, str) or not value or "\\" in value or "\x00" in value
            or any(ord(character) < 32 for character in value)):
        raise HelperSourceError("Pinned helper manifest contains an invalid relative path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or value != relative.as_posix() or any(part in {"", ".", ".."} for part in relative.parts):
        raise HelperSourceError("Pinned helper manifest path escapes its checkout")
    return relative


def _ensure_no_links(root, relative):
    current = root
    for component in relative.parts:
        current = current / component
        if current.is_symlink():
            raise HelperSourceError("Pinned helper path traverses a symlink: " + relative.as_posix())
    return current


def _read_tree(root, commit, paths, *, recursive_scripts=False):
    # The recursive directory already covers every script. Repeating its full
    # Python inventory can exceed CreateProcess command-line limits on Windows.
    pathspecs = (["scripts"] if recursive_scripts else []) + [
        ":(literal)" + name for name in paths
        if not recursive_scripts or (name != "scripts" and not name.startswith("scripts/"))
    ]
    raw = _git(root, "ls-tree", "-r", "-z", "--full-tree", commit, "--", *pathspecs)
    tree = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        relative = raw_path.decode("utf-8", "strict")
        if relative in tree:
            raise HelperSourceError("Pinned helper Git tree has a duplicate path: " + relative)
        tree[relative] = {"mode": mode, "type": object_type, "blob": object_id}
    return tree


def _read_index(root, paths, *, recursive_scripts=False):
    # The recursive directory already covers every script. Repeating its full
    # Python inventory can exceed CreateProcess command-line limits on Windows.
    pathspecs = (["scripts"] if recursive_scripts else []) + [
        ":(literal)" + name for name in paths
        if not recursive_scripts or (name != "scripts" and not name.startswith("scripts/"))
    ]
    raw = _git(root, "ls-files", "--stage", "-z", "--", *pathspecs)
    index = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, object_id, stage = metadata.decode("ascii").split(" ")
        relative = raw_path.decode("utf-8", "strict")
        index.setdefault(relative, []).append({"mode": mode, "blob": object_id, "stage": stage})
    return index


def _binding_manifest_sha256(commit, files):
    return hashlib.sha256(_canonical({"schema": SCHEMA, "commit": commit, "files": files})).hexdigest()


def current_executed_files():
    """Return the loaded host launcher modules that must come from this checkout."""
    result = {}
    for relative, module_name in _EXECUTED_MODULES.items():
        module = sys.modules.get(module_name)
        module_path = getattr(module, "__file__", None) if module is not None else None
        if module_path is not None:
            result[relative] = Path(module_path)
    if "scripts/docker_dev.py" not in result:
        raise HelperSourceError("The current docker_dev launcher module is unavailable")
    return result


def production_context_files(base_context_files, runtime_context_files):
    """Return every exact file consumed by both runtime wrapper image contexts."""
    paths = {"compose.dev.yaml"}
    for inventory, dockerfile in (
        (base_context_files, "Dockerfile.dev"),
        (runtime_context_files, "Dockerfile.backend"),
    ):
        for _target, relative in inventory:
            paths.add(_relative_path(relative).as_posix())
        paths.add(f"docker/all-in-one/{dockerfile}.dockerignore")
    return tuple(sorted(paths))


def capture_current_binding(root, commit, selected_source, base_context_files, runtime_context_files):
    return capture_binding(
        root,
        commit,
        selected_source,
        context_files=production_context_files(base_context_files, runtime_context_files),
        launcher_files=PRODUCTION_LAUNCHER_FILES,
        executed_files=current_executed_files(),
        include_script_python=True,
    )


def _working_script_python_paths(root):
    scripts = root / "scripts"
    if scripts.is_symlink() or not scripts.is_dir():
        raise HelperSourceError("Pinned helper scripts directory is missing or linked")
    found = set()

    def walk_error(error):
        raise HelperSourceError("Cannot inventory helper Python sources: " + str(error))

    for directory, children, filenames in os.walk(scripts, topdown=True, followlinks=False, onerror=walk_error):
        parent = Path(directory)
        linked = [name for name in children if (parent / name).is_symlink()]
        if linked:
            raise HelperSourceError("Pinned helper scripts contain a symlink directory: " + (parent / linked[0]).relative_to(root).as_posix())
        for name in filenames:
            if name.lower().endswith(".py"):
                found.add((parent / name).relative_to(root).as_posix())
    return found


def _batch_blobs(root, object_ids):
    unique = list(dict.fromkeys(object_ids))
    if not unique:
        return {}
    raw = _git(root, "cat-file", "--batch", data=("\n".join(unique) + "\n").encode("ascii"))
    blobs = {}
    offset = 0
    for expected_id in unique:
        newline = raw.find(b"\n", offset)
        if newline < 0:
            raise HelperSourceError("Pinned helper Git blob response is truncated")
        header = raw[offset:newline].decode("ascii", "strict").split(" ")
        if len(header) != 3 or header[0] != expected_id or header[1] != "blob":
            raise HelperSourceError("Pinned helper Git object is missing or is not a blob")
        try:
            size = int(header[2])
        except ValueError as error:
            raise HelperSourceError("Pinned helper Git blob size is malformed") from error
        if size < 0 or size > _MAX_FILE_BYTES:
            raise HelperSourceError("Pinned helper Git blob exceeds its size bound")
        start = newline + 1
        end = start + size
        if end >= len(raw) or raw[end:end + 1] != b"\n":
            raise HelperSourceError("Pinned helper Git blob body is truncated")
        blobs[expected_id] = raw[start:end]
        offset = end + 1
    if offset != len(raw):
        raise HelperSourceError("Pinned helper Git blob response has trailing bytes")
    return blobs


def capture_binding(root, commit, selected_source, *, context_files, launcher_files,
                    executed_files, include_script_python=False):
    """Bind a clean helper checkout and its executed host modules to a full commit."""
    pair = validate_option_pair(root, commit)
    if pair is None:
        raise HelperSourceError("An explicit helper-source pin is required")
    requested_root, commit = pair
    try:
        validated_root = validate_host_path(requested_root, "helper source checkout")
        validated_source = validate_host_path(Path(selected_source), "selected app source checkout")
        root = validated_root.resolve(strict=True)
        selected_source = validated_source.resolve(strict=True)
    except (OSError, ValueError) as error:
        raise HelperSourceError("Helper or app source checkout is not durable: " + str(error)) from error
    if not root.is_dir() or not selected_source.is_dir():
        raise HelperSourceError("Helper and app source paths must be existing directories")
    try:
        top = Path(_git(root, "rev-parse", "--show-toplevel").decode("utf-8", "strict").strip()).resolve(strict=True)
        head = _git(root, "rev-parse", "HEAD").decode("ascii", "strict").strip()
        if top != root:
            raise HelperSourceError("Helper source root must be the Git checkout root")
        if head != commit:
            raise HelperSourceError("Helper checkout HEAD differs from --helper-source-commit")
        if _common_git_directory(root) != _common_git_directory(selected_source):
            raise HelperSourceError("Helper and selected app checkouts must belong to the same Git repository")
    except (OSError, UnicodeError) as error:
        raise HelperSourceError("Cannot identify the helper Git checkout: " + str(error)) from error

    paths = {"compose.dev.yaml"}
    paths.update(_relative_path(item).as_posix() for item in context_files)
    paths.update(_relative_path(item).as_posix() for item in launcher_files)
    if not paths:
        raise HelperSourceError("Helper source manifest is empty")
    executed_files = dict(executed_files)
    if set(executed_files) - paths:
        raise HelperSourceError("An executing host helper is absent from the pinned manifest")
    for relative, current_path in executed_files.items():
        expected = root / _relative_path(relative)
        actual = Path(current_path)
        try:
            actual_resolved = actual.resolve(strict=True)
        except OSError as error:
            raise HelperSourceError("Executing host helper is unavailable: " + relative) from error
        if actual_resolved != expected.resolve(strict=True):
            raise HelperSourceError("Currently executing host helper is outside the pinned checkout: " + relative)
    if executed_files.get("scripts/docker_dev.py") is None:
        raise HelperSourceError("The executing scripts/docker_dev.py launcher must be pinned")

    tree = _read_tree(root, commit, sorted(paths), recursive_scripts=include_script_python)
    if include_script_python:
        tracked_python = {
            relative for relative, entry in tree.items()
            if relative.startswith("scripts/") and relative.lower().endswith(".py")
            and entry["type"] == "blob"
        }
        observed_python = _working_script_python_paths(root)
        if observed_python != tracked_python:
            missing = sorted(tracked_python - observed_python)
            extra = sorted(observed_python - tracked_python)
            detail = missing[0] if missing else extra[0]
            kind = "missing" if missing else "untracked or shadow"
            raise HelperSourceError("Pinned helper Python inventory has a " + kind + " file: " + detail)
        paths.update(tracked_python)
    ordered_paths = sorted(paths)
    index = _read_index(root, ordered_paths, recursive_scripts=include_script_python)
    tracked_paths = set(tree)
    if tracked_paths - paths:
        # The recursive listing is used only to qualify Python helper files;
        # unrelated script data remains outside the pinned launcher manifest.
        tree = {path: entry for path, entry in tree.items() if path in paths}
    missing = [path for path in ordered_paths if path not in tree or path not in index]
    if missing:
        raise HelperSourceError("Required helper file is not tracked at the pinned commit: " + missing[0])
    total = 0
    metadata_by_path = {}
    files = []
    for relative in ordered_paths:
        relative_path = _relative_path(relative)
        path = _ensure_no_links(root, relative_path)
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode):
            raise HelperSourceError("Pinned helper file is not a regular file: " + relative)
        if metadata.st_size > _MAX_FILE_BYTES:
            raise HelperSourceError("Pinned helper file exceeds its size bound: " + relative)
        total += metadata.st_size
        if total > _MAX_MANIFEST_BYTES:
            raise HelperSourceError("Pinned helper manifest exceeds its aggregate size bound")
        metadata_by_path[relative] = (path, metadata.st_size)
        git_entry = tree[relative]
        index_entries = index[relative]
        if (git_entry["type"] != "blob" or git_entry["mode"] not in {"100644", "100755"}
                or len(index_entries) != 1 or index_entries[0]["stage"] != "0"
                or index_entries[0]["mode"] != git_entry["mode"]
                or index_entries[0]["blob"] != git_entry["blob"]):
            raise HelperSourceError("Pinned helper file is not clean in the Git index: " + relative)
    blobs = _batch_blobs(root, [tree[relative]["blob"] for relative in ordered_paths])
    for relative in ordered_paths:
        path, expected_size = metadata_by_path[relative]
        git_entry = tree[relative]
        data = path.read_bytes()
        expected_data = blobs[git_entry["blob"]]
        if len(data) != expected_size or data != expected_data:
            raise HelperSourceError("Pinned helper file differs from pinned commit: " + relative)
        observed_blob = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
        if observed_blob != git_entry["blob"]:
            raise HelperSourceError("Pinned helper file hash differs from pinned commit: " + relative)
        files.append({
            "path": relative,
            "mode": git_entry["mode"],
            "git_blob": git_entry["blob"],
            "sha256": hashlib.sha256(data).hexdigest(),
        })

    startup_hashes = {
        name: next((entry["sha256"] for entry in files if entry["path"] == "scripts/" + name), None)
        for name in ("docker_startup_script.py", "fullmag_storage.py")
    }
    if any(value is None for value in startup_hashes.values()):
        raise HelperSourceError("Pinned helper manifest omits an image-owned startup helper")
    return {
        "schema": SCHEMA,
        "root": str(root),
        "app_source_root": str(selected_source),
        "commit": commit,
        "manifest_sha256": _binding_manifest_sha256(commit, files),
        "files": files,
        "startup_helper_hashes": startup_hashes,
    }


def validate_binding_record(binding):
    """Validate a persisted binding without requiring its original checkout."""
    expected_keys = {
        "schema", "root", "app_source_root", "commit", "manifest_sha256", "files",
        "startup_helper_hashes",
    }
    if not isinstance(binding, dict) or set(binding) != expected_keys or binding.get("schema") != SCHEMA:
        raise HelperSourceError("Helper-source binding receipt has an unknown schema or fields")
    root = binding.get("root")
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise HelperSourceError("Helper-source binding root is invalid")
    app_source_root = binding.get("app_source_root")
    if not isinstance(app_source_root, str) or not Path(app_source_root).is_absolute():
        raise HelperSourceError("Helper-source app checkout binding is invalid")
    commit = binding.get("commit")
    if not isinstance(commit, str) or not _SHA1.fullmatch(commit):
        raise HelperSourceError("Helper-source binding commit is invalid")
    files = binding.get("files")
    if not isinstance(files, list) or not files:
        raise HelperSourceError("Helper-source binding manifest is empty")
    paths = []
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "mode", "git_blob", "sha256"}:
            raise HelperSourceError("Helper-source binding manifest entry is malformed")
        path = _relative_path(entry["path"]).as_posix()
        if entry["mode"] not in {"100644", "100755"} or not _SHA1.fullmatch(str(entry["git_blob"])):
            raise HelperSourceError("Helper-source binding Git entry is invalid: " + path)
        if not isinstance(entry["sha256"], str) or not _SHA256.fullmatch(entry["sha256"]):
            raise HelperSourceError("Helper-source binding file hash is invalid: " + path)
        paths.append(path)
    if paths != sorted(set(paths)):
        raise HelperSourceError("Helper-source binding manifest is not canonical")
    digest = binding.get("manifest_sha256")
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest) or digest != _binding_manifest_sha256(commit, files):
        raise HelperSourceError("Helper-source binding manifest digest differs")
    startup_hashes = binding.get("startup_helper_hashes")
    expected_startup = {
        name: next((entry["sha256"] for entry in files if entry["path"] == "scripts/" + name), None)
        for name in ("docker_startup_script.py", "fullmag_storage.py")
    }
    if startup_hashes != expected_startup or any(value is None for value in expected_startup.values()):
        raise HelperSourceError("Helper-source startup helper hashes differ from the pinned manifest")
    return binding


def image_labels(binding):
    binding = validate_binding_record(binding)
    return {
        _IMAGE_LABELS["schema"]: SCHEMA,
        _IMAGE_LABELS["commit"]: binding["commit"],
        _IMAGE_LABELS["manifest_sha256"]: binding["manifest_sha256"],
        _IMAGE_LABELS["docker_startup_script_sha256"]: binding["startup_helper_hashes"]["docker_startup_script.py"],
        _IMAGE_LABELS["fullmag_storage_sha256"]: binding["startup_helper_hashes"]["fullmag_storage.py"],
    }


def startup_hashes_from_image_labels(labels, expected_binding=None):
    if not isinstance(labels, dict) or labels.get(_IMAGE_LABELS["schema"]) != SCHEMA:
        raise HelperSourceError("Runtime image has no pinned helper-source label contract")
    commit = labels.get(_IMAGE_LABELS["commit"])
    manifest = labels.get(_IMAGE_LABELS["manifest_sha256"])
    startup_hashes = {
        "docker_startup_script.py": labels.get(_IMAGE_LABELS["docker_startup_script_sha256"]),
        "fullmag_storage.py": labels.get(_IMAGE_LABELS["fullmag_storage_sha256"]),
    }
    if (not isinstance(commit, str) or not _SHA1.fullmatch(commit)
            or not isinstance(manifest, str) or not _SHA256.fullmatch(manifest)
            or any(not isinstance(value, str) or not _SHA256.fullmatch(value)
                   for value in startup_hashes.values())):
        raise HelperSourceError("Runtime image helper-source labels are malformed")
    if expected_binding is not None:
        binding = validate_binding_record(expected_binding)
        if (commit != binding["commit"] or manifest != binding["manifest_sha256"]
                or startup_hashes != binding["startup_helper_hashes"]):
            raise HelperSourceError("Runtime image helper-source labels differ from the recreation pin")
    return startup_hashes


def compare_operation_binding(operation_inputs, current_binding):
    """Require resume to present the exact helper pin stored before removal."""
    if not isinstance(operation_inputs, dict):
        raise HelperSourceError("Recreation operation inputs are malformed")
    if "helper_source" not in operation_inputs:
        if current_binding is not None:
            raise HelperSourceError("This recreation was not pinned to a helper source")
        return None
    stored = validate_binding_record(operation_inputs["helper_source"])
    if current_binding is None:
        raise HelperSourceError("The stored helper-source pin is required to resume recreation")
    current = validate_binding_record(current_binding)
    if current != stored:
        raise HelperSourceError("Current helper-source pin differs from the completed recreation")
    return stored


def revalidate_binding(binding, selected_source=None, *, context_files=None, launcher_files=None,
                       executed_files=None, base_context_files=None, runtime_context_files=None,
                       include_script_python=None):
    """Re-read all pinned inputs and require byte-for-byte equality with the receipt."""
    binding = validate_binding_record(binding)
    selected_source = selected_source or binding["app_source_root"]
    if context_files is None:
        if base_context_files is None or runtime_context_files is None:
            raise HelperSourceError("Runtime image context inventories are required to revalidate the helper pin")
        context_files = production_context_files(base_context_files, runtime_context_files)
    if include_script_python is None:
        include_script_python = launcher_files is None and base_context_files is not None
    launcher_files = launcher_files or PRODUCTION_LAUNCHER_FILES
    current = capture_binding(
        binding["root"], binding["commit"], selected_source,
        context_files=context_files,
        launcher_files=launcher_files,
        executed_files=executed_files or current_executed_files(),
        include_script_python=include_script_python,
    )
    if current != binding:
        raise HelperSourceError("Helper source changed after its recreation pin was recorded")
    return current
