#!/usr/bin/env python3
"""Project-owned storage paths and build ownership; never deletes user data.

This is a build guard, not an OS sandbox. Use host permissions to restrict tools
that do not use Fullmag's entrypoints. Resolve is read-only unless --create is set.
"""

from __future__ import annotations

import argparse
import ast
import errno
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import time
import uuid


SCHEMA = "fullmag_storage_v1"
NATIVE_BUILD_LOCK_WAIT_SECONDS = 120
WINDOWS_WORKSPACE_BUILD_REQUEST_RECEIPT_SCHEMA = "fullmag.windows-workspace-build-request-receipt.v1"
WINDOWS_WORKSPACE_BUILD_REQUEST_RECEIPT_FIELDS = frozenset({
    "schema", "request_id", "worktree_id", "profile", "execution_mode",
    "state", "exit_code", "build_manifest_sha256", "started_at", "finished_at",
})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
WINDOWS_WORKSPACE_STORAGE_PROFILES = {
    "release": "windows-native-fdm-cpu",
    "dev": "windows-native-fdm-cpu-dev",
}
PATH_OVERRIDES = {
    "FULLMAG_WINDOWS_BUILD_ROOT": "build_root",
    "FULLMAG_WINDOWS_CACHE_ROOT": "cache_root",
    "FULLMAG_WINDOWS_TEMP_ROOT": "temp_root",
    "FULLMAG_BUILD_ROOT": "build_root",
    "FULLMAG_CACHE_ROOT": "cache_root",
    "FULLMAG_TEMP_ROOT": "temp_root",
    "FULLMAG_WINDOWS_TARGET_DIR": "build_root",
    "CARGO_TARGET_DIR": "build_root",
    "CARGO_BUILD_BUILD_DIR": "build_root",
    "FULLMAG_CARGO_TARGET_DIR": "build_root",
    "FULLMAG_CARGO_TARGET_ROOT": "build_root",
    "CARGO_TARGET_ROOT": "build_root",
    "FULLMAG_FDM_NATIVE_BUILD_ROOT": "build_root",
    "FULLMAG_FRONTEND_ROOT": "frontend_root",
    "FULLMAG_WINDOWS_STATE_ROOT": "runtime_root",
    "FULLMAG_WINDOWS_FRONTEND_ROOT": "frontend_root",
    "FULLMAG_WINDOWS_NODE_MODULES_ROOT": "frontend_root",
    "FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT": "frontend_root",
    "FULLMAG_WINDOWS_CARGO_HOME": "cache_root",
    "FULLMAG_WINDOWS_RUSTUP_HOME": "cache_root",
    "FULLMAG_WINDOWS_PNPM_ROOT": "cache_root",
}
MANAGED_VARIABLES = set(PATH_OVERRIDES) | {
    "FULLMAG_PROJECT_STORAGE_ROOT", "FULLMAG_WINDOWS_VOLATILE_ROOT", "FULLMAG_STORAGE_PROFILE",
    "FULLMAG_STORAGE_LOCK_TOKEN", "FULLMAG_STORAGE_LOCK_KEY",
    "FULLMAG_BUILD_STORAGE_ROOT", "FULLMAG_STORAGE_USE_MANAGED_EXT4",
    "FULLMAG_NATIVE_STORAGE_PROFILE", "FULLMAG_NATIVE_BUILD_IMAGE",
    "FULLMAG_NATIVE_MOUNT_VIEW", "FULLMAG_MANAGED_NATIVE_ROOT",
    "FULLMAG_WINDOWS_VOLATILE_ROOT",
}


class StorageError(RuntimeError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if result.returncode:
        raise StorageError(f"Cannot identify Git checkout at {repo}: {result.stderr.strip()}")
    return result.stdout.strip()


def identifier(value):
    slug = re.sub(r"[^a-z0-9._-]+", "-", Path(value).name.lower()).strip(".-")[:32] or "worktree"
    digest = hashlib.sha256(os.path.normcase(str(value)).encode()).hexdigest()[:16]
    return f"{slug}-{digest}"


def absolute(value, label):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise StorageError(f"{label} must be an absolute path: {value}")
    # Do not silently accept a junction/symlink that redirects an approved root.
    lexical = Path(os.path.abspath(path))
    resolved = path.resolve()
    if os.path.normcase(str(lexical)) != os.path.normcase(str(resolved)):
        raise StorageError(f"{label} must not traverse a symlink/junction: {value} -> {resolved}")
    return resolved


def inside(path, root):
    return path == root or root in path.parents


def validate_path(value, root, label="output path"):
    path = absolute(value, label)
    root = Path(root).resolve()
    if not inside(path, root):
        raise StorageError(f"{label} must be contained by {root}: {path}")
    return path


def validate_workspace_request_id(value):
    """Require the canonical nonzero UUID used to scope one managed build."""
    if not isinstance(value, str):
        raise StorageError("Workspace request id must be a canonical lowercase UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError) as error:
        raise StorageError("Workspace request id must be a canonical lowercase UUID") from error
    if parsed.int == 0 or str(parsed) != value:
        raise StorageError("Workspace request id must be a canonical nonzero lowercase UUID")
    return value


def _workspace_build_request_receipt_path(layout, request_id, *, create_parent=False):
    request_id = validate_workspace_request_id(request_id)
    build_root = validate_path(layout["build_root"], layout["build_storage_root"], "managed build root")
    requests_root = validate_path(build_root / "build-requests", build_root, "workspace build request receipts")
    if create_parent:
        requests_root.mkdir(exist_ok=True)
        requests_root = validate_path(requests_root, build_root, "workspace build request receipts")
    receipt_path = validate_path(
        requests_root / f"{request_id}.json", build_root, "workspace build request receipt"
    )
    return receipt_path


def _reject_duplicate_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise StorageError("Workspace build request receipt has duplicate JSON keys")
        result[key] = value
    return result


def read_workspace_build_request_receipt(layout, request_id):
    """Read only the terminal receipt derived from this workspace and request id."""
    request_id = validate_workspace_request_id(request_id)
    path = _workspace_build_request_receipt_path(layout, request_id)
    if not path.is_file():
        raise StorageError("Workspace build request has no terminal receipt")
    before = path.stat()
    if before.st_size <= 0 or before.st_size > 16 * 1024:
        raise StorageError("Workspace build request receipt has an invalid size")
    try:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_json_object)
    except (OSError, UnicodeError, ValueError) as error:
        raise StorageError("Workspace build request receipt is unavailable or invalid") from error
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(raw) != after.st_size:
        raise StorageError("Workspace build request receipt changed while being read")
    if not isinstance(value, dict) or set(value) != WINDOWS_WORKSPACE_BUILD_REQUEST_RECEIPT_FIELDS:
        raise StorageError("Workspace build request receipt schema mismatch")
    state = value.get("state")
    if (
        value.get("schema") != WINDOWS_WORKSPACE_BUILD_REQUEST_RECEIPT_SCHEMA
        or value.get("request_id") != request_id
        or value.get("worktree_id") != layout.get("worktree_id")
        or value.get("profile") != layout.get("profile")
        or value.get("execution_mode") != "windows-workspace-build"
        or not isinstance(state, str)
        or state not in {"completed", "failed", "interrupted"}
        or (value.get("exit_code") is not None and type(value.get("exit_code")) is not int)
        or not isinstance(value.get("started_at"), str)
        or not value["started_at"]
        or not isinstance(value.get("finished_at"), str)
        or not value["finished_at"]
    ):
        raise StorageError("Workspace build request receipt scope or terminal state is invalid")
    manifest_sha256 = value.get("build_manifest_sha256")
    if manifest_sha256 is not None and (
        not isinstance(manifest_sha256, str) or not SHA256_RE.fullmatch(manifest_sha256)
    ):
        raise StorageError("Workspace build request receipt manifest pin is invalid")
    if value["state"] != "completed" or value["exit_code"] != 0 or manifest_sha256 is None:
        raise StorageError("Workspace build request did not complete with a pinned manifest")
    return value


def filesystem_type(path):
    """Read the actual filesystem, including when the output does not exist yet."""
    path = Path(path)
    while not path.exists() and path != path.parent:
        path = path.parent
    result = subprocess.run(["findmnt", "-n", "-o", "FSTYPE", "--target", str(path)], capture_output=True, text=True)
    if result.returncode:
        raise StorageError(f"Cannot establish Linux filesystem for {path}: {result.stderr.strip()}")
    return result.stdout.strip()


def linux_infrastructure(root, env):
    profile = env.get("FULLMAG_NATIVE_STORAGE_PROFILE", "canonical")
    if profile not in ("canonical", "native-2", "local-d"):
        raise StorageError(f"Unknown native storage profile: {profile}")
    image_name = "fullmag-native-2.ext4" if profile == "native-2" else "fullmag-native.ext4"
    mount = Path("/mnt/fullmag-zfn2-native-2" if profile == "native-2" else "/mnt/fullmag-zfn2-native")
    legacy = Path("/mnt/d/git/fullmag/fullmag-native.ext4") if profile == "local-d" else Path("/zfn2/mateuszz/git/fullmag/build-volumes") / image_name
    canonical = root / "build-volumes" / image_name
    # Existing loop images are infrastructure, not disposable cache. Never
    # copy/move them or create a second legacy image while another task uses it.
    image = canonical if canonical.exists() or not legacy.exists() else legacy
    return {"native_storage_profile": profile, "native_mount_view": str(mount),
            "native_backing_image": str(image), "native_storage_legacy": image == legacy}


def validate_managed_view(layout):
    if not layout.get("managed_ext4"):
        return
    mount = Path(layout["native_mount_view"])
    result = subprocess.run(["findmnt", "-n", "-o", "FSTYPE,SOURCE", "--target", str(mount)], capture_output=True, text=True)
    fields = result.stdout.strip().split()
    if result.returncode or len(fields) != 2 or fields[0] != "ext4" or not re.fullmatch(r"/dev/loop[0-9]+", fields[1]):
        raise StorageError(f"Managed build requires ext4 on a loop device at {mount}; observed {result.stdout.strip() or 'unmounted'}. No CIFS or temporary-directory fallback.")
    backing = Path("/sys/block") / Path(fields[1]).name / "loop/backing_file"
    observed = backing.read_text().strip()
    if observed != layout["native_backing_image"]:
        raise StorageError(f"Wrong managed backing image: expected {layout['native_backing_image']}, observed {observed}")


def storage_dotenv(main_repo):
    """Read only storage settings; never execute or interpolate dotenv values."""
    path = main_repo / ".env"
    if not path.is_file():
        return {}
    values = {}
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or key not in MANAGED_VARIABLES:
            continue
        value = value.strip()
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise StorageError(f"Invalid storage setting at {path}:{number}")
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        if value:
            values[key] = value
    return values


def resolve_layout(repo_root, profile=None, environ=None):
    env = os.environ if environ is None else environ
    repo = Path(git(repo_root, "rev-parse", "--show-toplevel")).resolve()
    if git(repo, "rev-parse", "--show-superproject-working-tree"):
        raise StorageError("Resolve storage from the Fullmag checkout, not a Git submodule")
    registrations = worktree_records(repo)
    main_repo = Path(registrations[0]["worktree"]).resolve()
    env = {**storage_dotenv(main_repo), **env}
    project = main_repo.parent
    profile = profile or env.get("FULLMAG_STORAGE_PROFILE") or ("windows-native" if os.name == "nt" else "linux-host")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", profile):
        raise StorageError(f"Invalid storage profile: {profile!r}")
    root = absolute(env.get("FULLMAG_PROJECT_STORAGE_ROOT", str(project / "storage")), "FULLMAG_PROJECT_STORAGE_ROOT")
    if root == Path(root.anchor) or inside(project, root):
        raise StorageError(f"Storage cannot contain the project or be a filesystem root: {root}")
    if root in {Path(root.anchor) / name for name in ("fullmag-build", "fullmag-cache", "fullmag-tmp")}:
        raise StorageError(f"Legacy storage is not a destination for new builds: {root}")
    marker = root / ".fullmag-storage.json"
    if marker.exists():
        validate_path(marker, root, "storage marker")
        if json.loads(marker.read_text(encoding="utf-8")) != {"schema": SCHEMA, "project_root": str(project)}:
            raise StorageError(f"Storage marker belongs to another project or schema: {marker}")
    elif root != project / "storage":
        raise StorageError(f"A non-default storage root must already be registered by the operator with a project marker: {root}. No automatic fallback or alternate-root initialization.")
    checkouts = [repo, main_repo]
    for registration in registrations:
        candidate = Path(registration["worktree"])
        # Registrations from a different OS may be stale; never interpret
        # their relative spelling as a directory in the current checkout.
        if candidate.is_absolute():
            checkouts.append(candidate.resolve())
    for checkout in checkouts:
        if inside(root, checkout) or inside(checkout, root):
            raise StorageError(f"Storage must be outside the repository and all worktrees: {root} overlaps {checkout}")
    wt = identifier(repo)
    platform = "windows" if os.name == "nt" else "linux"
    infrastructure = linux_infrastructure(root, env) if os.name != "nt" else {}
    if os.name != "nt":
        for name, field in (("FULLMAG_NATIVE_BUILD_IMAGE", "native_backing_image"), ("FULLMAG_NATIVE_MOUNT_VIEW", "native_mount_view")):
            if env.get(name) and absolute(env[name], name) != Path(infrastructure[field]):
                raise StorageError(f"{name} must match native storage profile {infrastructure['native_storage_profile']}: {infrastructure[field]}")
    if env.get("FULLMAG_MANAGED_NATIVE_ROOT") and os.name != "nt":
        if absolute(env["FULLMAG_MANAGED_NATIVE_ROOT"], "FULLMAG_MANAGED_NATIVE_ROOT") != Path(infrastructure["native_mount_view"]):
            raise StorageError("FULLMAG_MANAGED_NATIVE_ROOT must match the approved native mount view")
    managed = os.name != "nt" and (env.get("FULLMAG_STORAGE_USE_MANAGED_EXT4") == "1" or filesystem_type(root) in ("cifs", "smb3", "nfs", "nfs4"))
    build_storage = Path(infrastructure["native_mount_view"]) / "storage" if managed else root
    layout = {
        "schema": SCHEMA, "repo_root": str(repo), "project_root": str(project),
        "storage_root": str(root), "worktree_id": wt, "profile": profile,
        "worktrees_root": str(project / "worktrees"),
        "build_storage_root": str(build_storage), "managed_ext4": managed,
        "build_root": str(build_storage / "builds" / wt / profile),
        "cache_root": str(build_storage / "cache" / platform),
        "temp_root": str(build_storage / "tmp" / wt / profile),
        "runtime_root": str(build_storage / "runtimes" / wt),
        "frontend_root": str(build_storage / "builds" / wt / "frontend"),
        "runs_root": str(root / "runs" / wt),
        **infrastructure,
    }
    if env.get("FULLMAG_BUILD_STORAGE_ROOT") and absolute(env["FULLMAG_BUILD_STORAGE_ROOT"], "FULLMAG_BUILD_STORAGE_ROOT") != build_storage:
        raise StorageError("FULLMAG_BUILD_STORAGE_ROOT must match the resolved host/managed build view")
    # An override can select a subdirectory, not another worktree's mutable
    # build or a second storage tree. Validate every override before creating.
    for name, field in PATH_OVERRIDES.items():
        if env.get(name):
            candidate = validate_path(env[name], layout[field], name)
            if name == "FULLMAG_FRONTEND_ROOT" and candidate != Path(layout[field]):
                raise StorageError("FULLMAG_FRONTEND_ROOT is a stable worktree path and cannot be overridden")
            if name in {"FULLMAG_WINDOWS_BUILD_ROOT", "FULLMAG_BUILD_ROOT",
                        "FULLMAG_WINDOWS_CACHE_ROOT", "FULLMAG_CACHE_ROOT",
                        "FULLMAG_WINDOWS_TEMP_ROOT", "FULLMAG_TEMP_ROOT"}:
                layout[field] = str(candidate)
    build = Path(layout["build_root"])
    cache = Path(layout["cache_root"])
    temp = Path(layout["temp_root"])
    target = env.get("FULLMAG_WINDOWS_TARGET_DIR") or env.get("CARGO_TARGET_DIR") or str(build / "cargo-target")
    variables = {
        "FULLMAG_PROJECT_STORAGE_ROOT": str(root),
        "FULLMAG_PROJECT_ID": identifier(main_repo),
        "FULLMAG_BUILD_STORAGE_ROOT": str(build_storage),
        "FULLMAG_STORAGE_PROFILE": profile,
        "FULLMAG_WORKTREE_ID": wt,
        "FULLMAG_BUILD_ROOT": str(build), "FULLMAG_CACHE_ROOT": str(cache),
        "FULLMAG_TEMP_ROOT": str(temp), "FULLMAG_RUNTIME_ROOT": layout["runtime_root"],
        "FULLMAG_RUNS_ROOT": layout["runs_root"],
        "FULLMAG_FRONTEND_ROOT": layout["frontend_root"],
        "FULLMAG_CARGO_TARGET_DIR": target,
        "FULLMAG_CARGO_TARGET_ROOT": str(build / "cargo-targets"),
        "FULLMAG_FDM_NATIVE_BUILD_ROOT": env.get("FULLMAG_FDM_NATIVE_BUILD_ROOT", str(build / "native-fdm")),
        "CARGO_TARGET_DIR": target, "CARGO_HOME": str(cache / "cargo"),
        "RUSTUP_HOME": str(cache / "rustup"),
        "PNPM_HOME": str(cache / "pnpm-home"), "npm_config_store_dir": str(cache / "pnpm-store"),
        "npm_config_cache": str(cache / "npm"), "COREPACK_HOME": str(cache / "corepack"),
        "PIP_CACHE_DIR": str(cache / "pip"), "UV_CACHE_DIR": str(cache / "uv"),
        "CUDA_CACHE_PATH": str(cache / "cuda"), "PLAYWRIGHT_BROWSERS_PATH": str(cache / "playwright-browsers"),
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPYCACHEPREFIX": str(cache / "python-bytecode"),
        "TMPDIR": str(temp), "TEMP": str(temp), "TMP": str(temp),
    }
    if os.name == "nt":
        variables.update(FULLMAG_WINDOWS_BUILD_ROOT=str(build), FULLMAG_WINDOWS_CACHE_ROOT=str(cache), FULLMAG_WINDOWS_TEMP_ROOT=str(temp))
    else:
        variables.update(FULLMAG_NATIVE_STORAGE_PROFILE=infrastructure["native_storage_profile"],
                         FULLMAG_NATIVE_BUILD_IMAGE=infrastructure["native_backing_image"],
                         FULLMAG_NATIVE_MOUNT_VIEW=infrastructure["native_mount_view"],
                         FULLMAG_NATIVE_STORAGE_LEGACY="1" if infrastructure["native_storage_legacy"] else "0",
                         FULLMAG_MANAGED_EXT4="1" if managed else "0")
    if profile in WINDOWS_WORKSPACE_STORAGE_PROFILES.values():
        # Reduce intermediate path length for the MSVC linker's legacy path limit.
        # Final artifacts remain in target; existing caches are never removed.
        variables["CARGO_BUILD_BUILD_DIR"] = str(validate_path(
            env.get("CARGO_BUILD_BUILD_DIR") or build / "b", build, "CARGO_BUILD_BUILD_DIR"))
    elif env.get("CARGO_BUILD_BUILD_DIR"):
        variables["CARGO_BUILD_BUILD_DIR"] = env["CARGO_BUILD_BUILD_DIR"]
    layout["env"] = variables
    return layout


def worktree_records(repo):
    result = subprocess.run(["git", "-C", str(repo), "worktree", "list", "--porcelain", "-z"], capture_output=True, text=True)
    nul_format = result.returncode == 0
    if result.returncode == 129:
        # Ubuntu's supported older Git lacks worktree list -z. quotePath=false
        # keeps UTF-8 literal; Git still C-quotes control characters in paths.
        result = subprocess.run(["git", "-C", str(repo), "-c", "core.quotePath=false", "worktree", "list", "--porcelain"], capture_output=True, text=True)
    if result.returncode:
        raise StorageError(f"Cannot list Git worktrees at {repo}: {result.stderr.strip()}")
    records = []
    record = {}
    for field in result.stdout.split("\0" if nul_format else "\n"):
        if not field:
            if record:
                records.append(record)
                record = {}
            continue
        name, _, value = field.partition(" ")
        if not nul_format and name == "worktree" and value.startswith('"'):
            try:
                value = ast.literal_eval(value)
            except (ValueError, SyntaxError) as error:
                raise StorageError("Cannot decode the quoted Git worktree path") from error
            if not isinstance(value, str):
                raise StorageError("Invalid Git worktree path")
        record[name] = value if value else True
    if record:
        records.append(record)
    if not records or "worktree" not in records[0]:
        raise StorageError("Git returned no registered main checkout")
    return records


def atomic_json(path, data, *, retry_windows_replace=False):
    if type(retry_windows_replace) is not bool:
        raise StorageError("Invalid metadata replacement retry option")
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        deadline = time.monotonic() + 1.0 if retry_windows_replace and os.name == "nt" else None
        while True:
            try:
                os.replace(temporary, path)
                break
            except OSError as error:
                remaining = deadline - time.monotonic() if deadline is not None else 0
                # Windows readers/scanners can briefly deny atomic rename.
                # Retry only that final operation, never file creation or work.
                if remaining <= 0 or getattr(error, "winerror", None) not in (5, 32, 33):
                    raise
                time.sleep(min(0.05, remaining))
    finally:
        if temporary.exists():
            temporary.unlink()  # Only our own uncommitted metadata, never user data.


def initialize(layout):
    root = absolute(layout["storage_root"], "storage root")
    build_storage = absolute(layout["build_storage_root"], "build storage root")
    validate_managed_view(layout)
    # Recheck paths at the mutation boundary, including existing markers.
    for field in ("build_root", "cache_root", "temp_root", "runtime_root", "frontend_root"):
        validate_path(layout[field], build_storage, field)
    if layout["env"].get("CARGO_BUILD_BUILD_DIR"):
        validate_path(layout["env"]["CARGO_BUILD_BUILD_DIR"], layout["build_root"], "CARGO_BUILD_BUILD_DIR")
    validate_path(layout["runs_root"], root, "runs_root")
    for directory in ("index", "locks"):
        validate_path(root / directory, root, directory)
    marker = root / ".fullmag-storage.json"
    validate_path(marker, root, "storage marker")
    expected = {"schema": SCHEMA, "project_root": layout["project_root"]}
    root.mkdir(parents=True, exist_ok=True)
    # A locked atomic replace prevents concurrent readers seeing half a marker.
    with file_lock(validate_path(root / ".initialize.lock", root), "storage initialization", blocking=True):
        if marker.exists():
            try:
                actual = json.loads(marker.read_text(encoding="utf-8"))
            except (ValueError, OSError) as error:
                raise StorageError(f"Invalid storage marker at {marker}: {error}") from error
            if actual != expected:
                raise StorageError(f"Storage marker belongs to a different project or schema: {marker}")
        else:
            atomic_json(marker, expected)
    for directory in ("index", "locks"):
        (root / directory).mkdir(exist_ok=True)
    for field in ("build_root", "cache_root", "temp_root", "runtime_root", "frontend_root", "runs_root"):
        Path(layout[field]).mkdir(parents=True, exist_ok=True)


def is_link(path):
    # is_symlink excludes junctions on Python < 3.12. Both have the Windows
    # reparse-point attribute and must never be mistaken for owned real dirs.
    if path.is_symlink():
        return True
    try:
        return bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)
    except FileNotFoundError:
        return False


def _same_path(left, right):
    """Compare paths using the host's case and separator rules."""
    return os.path.normcase(os.path.abspath(str(left))) == os.path.normcase(os.path.abspath(str(right)))


def _worktree_link_roots(layout):
    """Return the storage namespaces allowed for this checkout's links."""
    build_storage = Path(layout["build_storage_root"])
    worktree = layout["worktree_id"]
    return (
        build_storage / "builds" / worktree,
        build_storage / "runtimes" / worktree,
    )


def _link_target_category(target, layout):
    """Resolve a target and return its owning worktree namespace, if any."""
    try:
        resolved = absolute(target, "managed link target")
    except StorageError:
        return None
    for root in _worktree_link_roots(layout):
        try:
            if inside(resolved, absolute(root, "managed link storage root")):
                return absolute(root, "managed link storage root")
        except StorageError:
            return None
    return None


def _registered_link_target(record, source):
    """Read a registry entry without trusting arbitrary path spelling."""
    key = str(source)
    if key in record:
        return record[key]
    source_key = os.path.normcase(os.path.abspath(key))
    for registered_source, target in record.items():
        if not isinstance(registered_source, str):
            continue
        if os.path.normcase(os.path.abspath(registered_source)) == source_key:
            return target
    return None


def _can_rebind_managed_link(source, destination, layout, record):
    """Allow only an indexed link moving within its own storage namespace."""
    registered_target = _registered_link_target(record, source)
    if not isinstance(registered_target, str) or not registered_target:
        return False
    try:
        current_target = source.resolve()
        indexed_target = absolute(registered_target, "indexed managed link target")
        desired_target = absolute(destination, "managed link target")
    except (OSError, RuntimeError, StorageError):
        return False
    if not _same_path(current_target, indexed_target):
        return False
    current_category = _link_target_category(current_target, layout)
    desired_category = _link_target_category(desired_target, layout)
    return current_category is not None and desired_category is not None and _same_path(current_category, desired_category)


def prepare_links(layout, frontend=False, compat=False, next_dist_dir=None):
    repo = Path(layout["repo_root"])
    build_storage = Path(layout["build_storage_root"])
    front = Path(layout["frontend_root"])
    links = {}
    if compat:
        links[repo / ".fullmag"] = Path(layout["runtime_root"])
        links[repo / "target"] = Path(layout["env"]["CARGO_TARGET_DIR"])
    if frontend:
        app = repo / "apps/control-room"
        links.update({repo / "node_modules": front / "node_modules",
                      app / "node_modules": front / "apps/control-room/node_modules",
                      app / ".fullmag-frontend": front,
                      app / ".next": front / "next/default",
                      app / ".next-audit": front / "next/audit",
                      app / "out": front / "out",
                      app / ".artifacts": front / "artifacts",
                      app / "storybook-static": front / "storybook-static"})
        if next_dist_dir and next_dist_dir not in (".next", ".next-audit"):
            dev = re.fullmatch(r"\.next-control-room-([0-9]{1,5})", next_dist_dir)
            smoke = re.fullmatch(r"\.next-audit-target-smoke-([a-z0-9-]+)", next_dist_dir)
            if dev and 1 <= int(dev[1]) <= 65535:
                destination = "dev-" + dev[1]
            elif smoke:
                destination = "smoke-" + smoke[1]
            else:
                raise StorageError(f"Unsupported Next output directory: {next_dist_dir}")
            links[app / next_dist_dir] = front / "next" / destination
    elif next_dist_dir:
        raise StorageError("--next-dist-dir requires --frontend")
    # Inspect the entire plan before creating a single output directory/link.
    # A mismatched link is evaluated again under the per-worktree lock below;
    # it can only be rebound when the registry proves that this checkout owned
    # its previous target and both targets remain in the same storage namespace.
    for source, destination in links.items():
        validate_path(destination, build_storage, "compatibility target")
        absolute(source.parent, "compatibility source parent")
        if not is_link(source) and source.exists():
            raise StorageError(f"Existing real path requires inventoried migration, never automatic removal: {source}")
    initialize(layout)
    with build_lock(layout):
        record = validate_path(Path(layout["storage_root"]) / "index" / f"{layout['worktree_id']}.links.json", layout["storage_root"], "link registry")
        if record.exists():
            try:
                previous = json.loads(record.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise StorageError(f"Invalid managed link registry: {record}") from error
            if not isinstance(previous, dict):
                raise StorageError(f"Invalid managed link registry: {record}")
        else:
            previous = {}
        for source, destination in links.items():
            destination.mkdir(parents=True, exist_ok=True)
            if is_link(source):
                if _same_path(source.resolve(), destination):
                    continue
                if not _can_rebind_managed_link(source, destination, layout, previous):
                    raise StorageError(f"Existing link targets a different storage location: {source} -> {source.resolve()}; expected {destination}")
                # The source is still known to be a reparse point/symlink under
                # the lock. Never unlink a real directory or a foreign link.
                source.unlink()
            if source.exists():
                raise StorageError(f"Compatibility path appeared during preparation: {source}")
            source.parent.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                # New-Item's -Path is literal for these repository-owned names.
                # Values travel as environment data, never shell fragments.
                result = subprocess.run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                                         "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:FULLMAG_LINK_SOURCE -Value $env:FULLMAG_LINK_TARGET | Out-Null"],
                                        env={**os.environ, "FULLMAG_LINK_SOURCE": str(source), "FULLMAG_LINK_TARGET": str(destination)},
                                        capture_output=True, text=True)
                if result.returncode:
                    raise StorageError(f"Cannot prepare link {source}: {result.stderr.strip()}")
            else:
                source.symlink_to(destination, target_is_directory=True)
            if not is_link(source) or source.resolve() != destination:
                raise StorageError(f"Compatibility link validation failed: {source}")
        previous.update({str(source): str(destination) for source, destination in links.items()})
        atomic_json(record, previous)
    return {str(source): str(destination) for source, destination in links.items()}


def validate_prepared_links_for_run(layout):
    """Reject a stale compatibility link before a managed command starts."""
    repo = Path(layout["repo_root"])
    build_storage = Path(layout["build_storage_root"])
    links = {
        repo / ".fullmag": Path(layout["runtime_root"]),
        repo / "target": Path(layout["env"]["CARGO_TARGET_DIR"]),
    }
    for source, destination in links.items():
        if not is_link(source) and not source.exists():
            continue
        validate_path(destination, build_storage, "compatibility target")
        if not is_link(source):
            raise StorageError(f"Existing real path requires inventoried migration, never automatic removal: {source}")
        try:
            current_target = source.resolve()
        except (OSError, RuntimeError) as error:
            raise StorageError(f"Cannot resolve managed compatibility link before run: {source}") from error
        if not _same_path(current_target, destination):
            raise StorageError(f"Existing link targets a different storage location: {source} -> {current_target}; expected {destination}")


def validate_existing_build_status(path, layout):
    """Do not overwrite a file that is not a status record for this run."""
    if not path.exists():
        return
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise StorageError(f"Existing build status is not a valid managed record: {path}") from error
    previous_repo = previous.get("repo_root") if isinstance(previous, dict) else None
    if not isinstance(previous, dict) or previous.get("schema") != SCHEMA or \
       previous.get("worktree_id") != layout["worktree_id"] or \
       previous.get("profile") != layout["profile"] or \
       not isinstance(previous_repo, str) or \
       not _same_path(previous_repo, layout["repo_root"]):
        raise StorageError(f"Existing build status belongs to another worktree or profile: {path}")


@contextmanager
def file_lock(lock_path, key, blocking=False, *, wait_timeout_seconds=0, cancelled=None):
    if (isinstance(wait_timeout_seconds, bool)
            or not isinstance(wait_timeout_seconds, (int, float))
            or not 0 <= wait_timeout_seconds <= NATIVE_BUILD_LOCK_WAIT_SECONDS
            or (blocking and wait_timeout_seconds)):
        raise StorageError("Invalid bounded storage lock wait")
    if cancelled is not None and not callable(cancelled):
        raise StorageError("Invalid storage lock cancellation check")
    with lock_path.open("a+b") as stream:
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        deadline = time.monotonic() + wait_timeout_seconds if wait_timeout_seconds else None
        def check_admission():
            if cancelled is not None and cancelled():
                raise StorageError(f"Native build cancelled before starting: {key}")
            if deadline is not None and time.monotonic() >= deadline:
                raise StorageError(f"Storage is busy: {key}. Bounded wait expired before starting.")

        reported_wait = False
        while True:
            check_admission()
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                break
            except OSError as error:
                remaining = deadline - time.monotonic() if deadline is not None else 0
                if remaining <= 0 or error.errno not in (errno.EACCES, errno.EAGAIN):
                    raise StorageError(f"Storage is busy: {key}. Reuse the running task or wait; do not allocate a random target.") from error
                if not reported_wait:
                    print(f"[fullmag storage] Waiting for busy resource: {key} (up to {wait_timeout_seconds}s)", flush=True)
                    reported_wait = True
                time.sleep(min(0.25, remaining))
        try:
            check_admission()
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


@contextmanager
def build_lock(layout, *, wait_timeout_seconds=0, cancelled=None):
    root = Path(layout["storage_root"])
    # ponytail: serialize writes per worktree because compatibility paths are
    # shared across profiles; independent worktrees still build concurrently.
    key = layout["worktree_id"]
    lock_path = validate_path(root / "locks" / f"{key}.lock", root, "build lock")
    owner_path = validate_path(root / "locks" / f"{key}.owner.json", root, "lock owner")
    inherited = os.environ.get("FULLMAG_STORAGE_LOCK_TOKEN")
    if inherited and os.environ.get("FULLMAG_STORAGE_LOCK_KEY") == key:
        owner = json.loads(owner_path.read_text(encoding="utf-8")) if owner_path.exists() else {}
        if owner.get("token") == inherited and owner.get("state") == "active" and owner.get("host") == socket.gethostname() and process_alive(owner.get("pid", -1)):
            if cancelled is not None and cancelled():
                raise StorageError("Native build cancelled before starting")
            yield
            return
        raise StorageError("Inherited storage lock is stale; start a fresh managed command")
    with file_lock(lock_path, key, wait_timeout_seconds=wait_timeout_seconds, cancelled=cancelled):
        token = uuid.uuid4().hex
        owner = {"token": token, "pid": os.getpid(), "host": socket.gethostname(), "state": "active", "started_at": now()}
        atomic_json(owner_path, owner)
        previous = {name: os.environ.get(name) for name in ("FULLMAG_STORAGE_LOCK_TOKEN", "FULLMAG_STORAGE_LOCK_KEY")}
        os.environ.update(FULLMAG_STORAGE_LOCK_TOKEN=token, FULLMAG_STORAGE_LOCK_KEY=key)
        try:
            yield
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
            owner.update(state="released", finished_at=now())
            atomic_json(owner_path, owner)


def process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _is_native_windows():
    return os.name == "nt"


def resolve_windows_workspace_backend_profile(frontend, backend_profile="release"):
    """Resolve the bounded Windows workspace compiler profile."""
    if frontend not in ("static", "dev"):
        raise StorageError("Windows workspace frontend must be static or dev")
    if backend_profile == "auto":
        return "dev" if frontend == "dev" else "release"
    if backend_profile not in WINDOWS_WORKSPACE_STORAGE_PROFILES:
        raise StorageError("Windows workspace backend profile must be auto, dev or release")
    return backend_profile


def _validate_windows_workspace_profile(layout, backend_profile):
    expected = WINDOWS_WORKSPACE_STORAGE_PROFILES.get(backend_profile)
    if expected is None or layout.get("profile") != expected:
        raise StorageError(
            "Native Windows workspace storage profile must match the selected compiler profile "
            f"({backend_profile!r} requires {expected!r})"
        )


def _native_build_cancellation(layout, active):
    """Bind a background build's admission to its already-verified UI owner."""
    if active is None:
        return None
    generation = active.get("launch_nonce")
    manager = active.get("manager_pid")
    if (not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{32}", generation)
            or type(manager) is not int or manager <= 0):
        raise StorageError("Native background build has no verified owner generation")
    from windows.runtime_lease import _read_runtime_status
    runtime = Path(layout["runtime_root"])
    status = validate_path(runtime / "native-workspace-status.json", runtime, "native build owner")
    stop = validate_path(runtime / f"native-watch-stop-{generation}.json", runtime, "native build stop")

    def cancelled():
        if stop.exists() or not process_alive(manager):
            return True
        current = _read_runtime_status(status)
        return (current is None or current.get("state") != "running"
                or current.get("launch_nonce") != generation
                or current.get("manager_pid") != manager
                or current.get("worktree_id") != layout["worktree_id"]
                or current.get("repo_root") != layout["repo_root"])
    return cancelled


@contextmanager
def managed_heavy_lock(layout, *, native_user_build=False, cancelled=None):
    """Share the local heavy slot with snapshot workers, including recovery.

Nested managed commands are validated by build_lock below. An orphaned
container keeps its durable queue lease even after the host file lock closes.
"""
    if native_user_build and (
        not _is_native_windows()
        or layout.get("profile") not in WINDOWS_WORKSPACE_STORAGE_PROFILES.values()
    ):
        raise StorageError("Native user build requires one of the fixed Windows workspace profiles")
    if native_user_build:
        # User-requested native Windows builds are independent of the Linux
        # queue. Serialize only other native builds using this host toolchain.
        root = Path(layout["storage_root"])
        with file_lock(validate_path(root / "locks" / "fullmag-native-windows-heavy.lock", root),
                       "native Windows Fullmag build", wait_timeout_seconds=NATIVE_BUILD_LOCK_WAIT_SECONDS,
                       cancelled=cancelled):
            yield
        return
    if (
        layout['profile'].startswith('windows-')
        and (Path(layout['storage_root']) / 'index' / 'local-runner-container.json').exists()
        and not native_user_build
    ):
        raise StorageError('Container runner owns heavy builds on this host; submit a snapshot through just runner-build')
    if not layout['profile'].startswith('windows-') or (
            not native_user_build and
            os.environ.get('FULLMAG_STORAGE_LOCK_TOKEN') and
            os.environ.get('FULLMAG_STORAGE_LOCK_KEY') == layout['worktree_id']):
        yield
        return
    root = Path(layout['storage_root'])
    with file_lock(validate_path(root / 'locks' / 'fullmag-heavy.lock', root), 'heavy Fullmag job'):
        database = validate_path(root / 'index' / 'runner-jobs.sqlite', root)
        if database.exists():
            from local_runner.queue import JobQueue
            if JobQueue(database, readonly=True).active():
                raise StorageError('A queued worker retains the heavy lease; wait or reconcile its exact container')
        yield


def _run_logged_command(command, repo_root, child_env, log_path, *, cancelled=None):
    """Keep complete compiler diagnostics, including stderr and nonzero exits."""
    with log_path.open("xb") as log:
        if cancelled is not None and cancelled():
            raise StorageError("Native build cancelled before command launch")
        with subprocess.Popen(command, cwd=repo_root, env=child_env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
            for line in iter(child.stdout.readline, b""):
                log.write(line)
                log.flush()
                print(line.decode("utf-8", errors="replace"), end="", flush=True)
            return subprocess.CompletedProcess(command, child.wait())


def _run_managed_command(
    layout,
    command,
    *,
    acquire_heavy_slot=True,
    native_user_build=False,
    native_workspace_paths=False,
    workspace_backend_profile=None,
    execution_mode="managed",
    result_record=None,
    workspace_request_id=None,
):
    if workspace_request_id is not None:
        workspace_request_id = validate_workspace_request_id(workspace_request_id)
        if not (
            native_user_build
            and native_workspace_paths
            and execution_mode == "windows-workspace-build"
        ):
            raise StorageError("Workspace request ids are only valid for the closed Windows workspace build operation")
    if native_user_build or native_workspace_paths:
        _validate_windows_workspace_profile(layout, workspace_backend_profile)
        if not _is_native_windows() or execution_mode not in (
            "windows-workspace",
            "windows-workspace-build",
        ):
            raise StorageError("Native workspace paths require the fixed Windows workspace operation")
        if native_user_build and (
            not native_workspace_paths or execution_mode != "windows-workspace-build"
        ):
            raise StorageError("Native user builds require the closed Windows workspace build operation")
    if not command:
        raise StorageError("A command is required after --")
    cancel_check = None
    if native_workspace_paths:
        from windows.runtime_lease import active_runtime, assert_no_independent_service
        # An uncertain previous owner must block even registry/bootstrap writes.
        # Recheck after acquiring the build lease before any dependency mutation.
        initial_active = active_runtime(layout)
        if native_user_build and workspace_request_id is not None:
            cancel_check = _native_build_cancellation(layout, initial_active)
        assert_no_independent_service(layout)
    initialize(layout)
    heavy_lock = (
        managed_heavy_lock(layout, native_user_build=native_user_build, cancelled=cancel_check)
        if acquire_heavy_slot
        else nullcontext()
    )
    if execution_mode == "windows-workspace" and native_workspace_paths:
        from windows.runtime_lease import run_sealed_runtime
        return run_sealed_runtime(layout, command, {**os.environ, **layout["env"]}, workspace_backend_profile)
    with heavy_lock, build_lock(layout, wait_timeout_seconds=NATIVE_BUILD_LOCK_WAIT_SECONDS if native_user_build else 0,
                                cancelled=cancel_check):
        request_receipt_path = None
        if workspace_request_id is not None:
            request_receipt_path = _workspace_build_request_receipt_path(
                layout, workspace_request_id, create_parent=True
            )
            if os.path.lexists(request_receipt_path):
                raise StorageError("Workspace build request id already has a receipt; request ids cannot be replayed")
        child_env = {**os.environ, **layout["env"]}
        if execution_mode == "windows-workspace-build" and native_user_build:
            from windows.runtime_lease import active_runtime, assert_frozen_dependencies, assert_no_independent_service
            assert_no_independent_service(layout, child_env)
            active = active_runtime(layout)
            child_env.pop("FULLMAG_NATIVE_RUNTIME_ACTIVE", None)
            child_env.pop("FULLMAG_NATIVE_ACTIVE_DEPENDENCY_SHA256", None)
            if active:
                if workspace_backend_profile != "dev" or command[command.index("-Frontend") + 1] != "dev":
                    raise StorageError("Save and close the active workspace before changing its build profile")
                child_env["FULLMAG_NATIVE_ACTIVE_DEPENDENCY_SHA256"] = assert_frozen_dependencies(layout, active)
                child_env["FULLMAG_NATIVE_RUNTIME_ACTIVE"] = "1"
        # `prepare-links` may have run in a separate shell and lock scope.  A
        # different lane can therefore have rebound the shared target link in
        # between; never execute a command against that stale profile.
        if not native_workspace_paths:
            validate_prepared_links_for_run(layout)
        record = validate_path(Path(layout["build_root"]) / "build-status.json", layout["build_storage_root"], "build status")
        validate_existing_build_status(record, layout)
        state = {"schema": SCHEMA, "worktree_id": layout["worktree_id"], "profile": layout["profile"],
                 "repo_root": layout["repo_root"], "head": git(layout["repo_root"], "rev-parse", "HEAD"),
                 "source_dirty": bool(git(layout["repo_root"], "status", "--porcelain", "--untracked-files=normal")),
                 "pid": os.getpid(), "host": socket.gethostname(), "started_at": now(),
                 "state": "running", "executable": Path(command[0]).name,
                 "build_root": layout["build_root"], "frontend_root": layout["frontend_root"],
                 "runtime_root": layout["runtime_root"], "qualification": "not_assessed",
                 "execution_mode": execution_mode}
        atomic_json(record, state)
        try:
            if cancel_check is not None and cancel_check():
                raise StorageError("Native build cancelled before command launch")
            if native_user_build:
                log_path = validate_path(Path(layout["build_root"]) / "logs" /
                                         ("native-build-" + uuid.uuid4().hex + ".log"),
                                         layout["build_root"], "native build log")
                log_path.parent.mkdir(parents=True, exist_ok=True)
                state["log_path"] = str(log_path)
                atomic_json(record, state)
                print(f"[fullmag storage] Build log: {log_path}", flush=True)
                result = _run_logged_command(command, layout["repo_root"], child_env, log_path,
                                             cancelled=cancel_check)
            else:
                result = subprocess.run(command, cwd=layout["repo_root"], env=child_env)
            state.update(state="completed" if result.returncode == 0 else "failed", exit_code=result.returncode)
            terminal_returncode = result.returncode
            if native_user_build and result.returncode == 0:
                manifest = validate_path(
                    Path(layout["build_root"]) / "windows-runtime" / "build-manifest.json",
                    layout["build_root"],
                    "Windows runtime build manifest",
                )
                if manifest.is_file():
                    raw_manifest = manifest.read_bytes()
                    state["build_manifest_sha256"] = hashlib.sha256(raw_manifest).hexdigest()
                elif workspace_request_id is not None:
                    # A successful compiler exit is not a request-scoped ready
                    # result unless its exact terminal manifest can be pinned.
                    state.update(state="failed", exit_code=1)
                    terminal_returncode = 1
            return terminal_returncode
        except BaseException:
            state.update(state="interrupted")
            raise
        finally:
            state["finished_at"] = now()
            atomic_json(record, state)
            if result_record is not None:
                result_record.update(state)
            if request_receipt_path is not None:
                if os.path.lexists(request_receipt_path):
                    raise StorageError("Workspace build request receipt already exists; refusing to overwrite it")
                atomic_json(request_receipt_path, {
                    "schema": WINDOWS_WORKSPACE_BUILD_REQUEST_RECEIPT_SCHEMA,
                    "request_id": workspace_request_id,
                    "worktree_id": layout["worktree_id"],
                    "profile": layout["profile"],
                    "execution_mode": execution_mode,
                    "state": state.get("state"),
                    "exit_code": state.get("exit_code"),
                    "build_manifest_sha256": state.get("build_manifest_sha256"),
                    "started_at": state.get("started_at"),
                    "finished_at": state.get("finished_at"),
                })


def run(layout, command):
    return _run_managed_command(layout, command, acquire_heavy_slot=True, execution_mode="managed")


def _windows_workspace_request(layout, frontend, web_port, backend_profile):
    selected_profile = resolve_windows_workspace_backend_profile(frontend, backend_profile)
    if not _is_native_windows():
        raise StorageError("Windows workspace runtime requires native Windows")
    _validate_windows_workspace_profile(layout, selected_profile)
    try:
        port = int(web_port)
    except (TypeError, ValueError) as error:
        raise StorageError("Windows workspace web port must be an integer from 1 to 65535") from error
    if not 1 <= port <= 65535:
        raise StorageError("Windows workspace web port must be an integer from 1 to 65535")
    launcher = validate_path(
        Path(layout["repo_root"]) / "scripts" / "windows" / "run_fullmag.ps1",
        layout["repo_root"],
        "Windows workspace launcher",
    )
    if not launcher.is_file():
        raise StorageError(f"Windows workspace launcher is missing: {launcher}")
    return selected_profile, port, launcher


def run_windows_workspace(
    layout, frontend, web_port, build_mode="auto", backend_profile="release",
    skip_local_changes=False,
):
    """Build, when requested, then run the native empty authoring workspace.

    This is deliberately a closed operation rather than a second spelling of
    ``run``: it accepts only the packaged Windows workspace parameters and
    derives the launcher command from this checkout.  An ``auto`` or ``true``
    build is admitted under the shared heavy slot, then the UI runtime runs
    with ``BuildMode=false`` after that slot is released.  Build and solver
    routes outside this closed operation continue to use ``run`` unchanged.
    """
    if build_mode not in ("auto", "true", "false"):
        raise StorageError("Windows workspace build mode must be auto, true or false")
    selected_profile, port, launcher = _windows_workspace_request(
        layout, frontend, web_port, backend_profile
    )
    runtime_command = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", str(launcher),
        "-BuildMode", "false", "-Frontend", frontend,
        "-BackendProfile", selected_profile,
        "-Backend", "auto", "-Device", "auto", "-RunMode", "workspace",
        "-WebPort", str(port),
    ]
    if skip_local_changes:
        runtime_command.append("-SkipLocalChanges")
    if build_mode != "false":
        build_command = [
            "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass", "-File", str(launcher),
            "-BuildMode", build_mode, "-Frontend", frontend,
            "-BackendProfile", selected_profile,
            "-Backend", "auto", "-Device", "auto", "-RunMode", "workspace",
            "-WebPort", str(port), "-BuildOnly",
        ]
        if skip_local_changes:
            build_command.append("-SkipLocalChanges")
        build_receipt = {}
        build_result = _run_managed_command(
            layout,
            build_command,
            acquire_heavy_slot=True,
            native_user_build=True,
            native_workspace_paths=True,
            workspace_backend_profile=selected_profile,
            execution_mode="windows-workspace-build",
            result_record=build_receipt,
        )
        if build_result != 0:
            return build_result
        if selected_profile == "dev" and frontend == "dev" and not skip_local_changes:
            # Launch the verified output of this explicit build request even
            # if another agent edits the checkout before the launcher starts.
            identity = build_receipt.get("build_manifest_sha256")
            if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
                raise StorageError("Native build completed without a pinned output manifest")
            runtime_command.extend(["-ExpectedBuildId", identity])
    return _run_managed_command(
        layout,
        runtime_command,
        acquire_heavy_slot=False,
        native_workspace_paths=True,
        workspace_backend_profile=selected_profile,
        execution_mode="windows-workspace",
    )


def run_windows_workspace_build(
    layout, frontend, web_port, backend_profile, build_mode="auto",
    skip_local_changes=False, workspace_request_id=None,
):
    """Build the native workspace through its fixed, receipt-backed route."""
    if backend_profile not in WINDOWS_WORKSPACE_STORAGE_PROFILES:
        raise StorageError("Windows workspace build profile must be dev or release")
    if build_mode not in ("auto", "true"):
        raise StorageError("Windows workspace build-only mode must be auto or true")
    selected_profile, port, launcher = _windows_workspace_request(
        layout, frontend, web_port, backend_profile
    )
    command = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", str(launcher),
        "-BuildMode", build_mode, "-Frontend", frontend,
        "-BackendProfile", selected_profile,
        "-Backend", "auto", "-Device", "auto", "-RunMode", "workspace",
        "-WebPort", str(port), "-BuildOnly",
    ]
    if skip_local_changes:
        command.append("-SkipLocalChanges")
    return _run_managed_command(
        layout,
        command,
        acquire_heavy_slot=True,
        native_user_build=True,
        native_workspace_paths=True,
        workspace_backend_profile=selected_profile,
        execution_mode="windows-workspace-build",
        workspace_request_id=workspace_request_id,
    )


def register(layout, task_id, owner, purpose, state="active"):
    if not task_id.strip() or not owner.strip() or not purpose.strip():
        raise StorageError("Task id, owner and purpose must be nonempty")
    initialize(layout)
    path = validate_path(Path(layout["storage_root"]) / "index" / f"{layout['worktree_id']}.json", layout["storage_root"], "worktree registry")
    with build_lock(layout):
        previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if previous and previous.get("task_id") != task_id and (previous.get("state") == "active" or state != "active"):
            raise StorageError(f"Worktree is owned by active task {previous['task_id']}: {layout['repo_root']}")
        record = {"schema": SCHEMA, "worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"],
                  "task_id": task_id, "owner": owner, "purpose": purpose, "state": state,
                  "branch": git(layout["repo_root"], "branch", "--show-current"),
                  "head": git(layout["repo_root"], "rev-parse", "HEAD"), "updated_at": now(),
                  "base_commit": previous.get("base_commit", git(layout["repo_root"], "rev-parse", "HEAD")),
                  "created_at": previous.get("created_at", now())}
        atomic_json(path, record)
    return record


def inventory(layout):
    """Read registered and legacy resources without traversing worktree links."""
    root = Path(layout["storage_root"])
    records = []
    for path in sorted((root / "index").glob("*.json")):
        validate_path(path, root, "index record")
        record = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(record, dict) and record.get("schema") == SCHEMA and record.get("worktree_id"):
            records.append(record)
    owners = {os.path.normcase(record["repo_root"]): record for record in records}
    checkouts = []
    for registration in worktree_records(layout["repo_root"]):
        path = Path(registration["worktree"])
        local = path.is_absolute()
        owner = owners.get(os.path.normcase(str(path)), {})
        checkouts.append({"path": str(path), "exists": local and path.is_dir(),
                          "branch": registration.get("branch"), "prunable": "prunable" in registration,
                          "task_id": owner.get("task_id"), "state": owner.get("state", "unregistered")})
    legacy = []
    project = Path(layout["project_root"])
    candidates = [project / name for name in ("build", ".cargo-target", ".pnpm-store", "fullmag-worktrees", "run_output")]
    if os.name == "nt":
        candidates.extend(Path(project.anchor) / name for name in ("fullmag-build", "fullmag-cache", "fullmag-tmp"))
    for path in candidates:
        if path.exists():
            legacy.append({"path": str(path), "state": "legacy-unclassified", "deletion_approved": False})
    return {"storage_root": str(root), "build_storage_root": layout["build_storage_root"],
            "worktree_count": len(checkouts), "unregistered_count": sum(item["state"] == "unregistered" for item in checkouts),
            "worktrees": checkouts, "records": records, "legacy": legacy,
            "note": "Inventory is not a deletion plan. Dirty files, unique commits, processes and mounts require a separate check."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("resolve", "validate", "run", "run-windows-workspace", "run-windows-workspace-build", "register", "finish", "inventory", "prepare-links", "assert-lock"))
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--profile")
    parser.add_argument("--format", choices=("json", "sh"), default="json")
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--path")
    parser.add_argument("--frontend", action="store_true")
    parser.add_argument("--workspace-frontend", choices=("static", "dev"))
    parser.add_argument("--workspace-backend-profile", choices=("auto", "dev", "release"))
    parser.add_argument("--workspace-web-port", type=int)
    parser.add_argument("--workspace-build-mode", choices=("auto", "true", "false"), default="auto")
    parser.add_argument("--workspace-skip-local-changes", action="store_true")
    parser.add_argument("--workspace-request-id")
    parser.add_argument("--compat", action="store_true")
    parser.add_argument("--next-dist-dir")
    parser.add_argument("--task-id")
    parser.add_argument("--owner")
    parser.add_argument("--purpose")
    parser.add_argument("--state", choices=("review", "blocked", "wip", "completed"), default="review")
    args_list = list(sys.argv[1:] if argv is None else argv)
    command = []
    if "--" in args_list:
        position = args_list.index("--")
        args_list, command = args_list[:position], args_list[position + 1:]
    args = parser.parse_args(args_list)
    try:
        if args.workspace_request_id is not None:
            validate_workspace_request_id(args.workspace_request_id)
            if args.action != "run-windows-workspace-build":
                raise StorageError("--workspace-request-id is only valid for run-windows-workspace-build")
        selected_workspace_profile = None
        selected_storage_profile = None
        if args.action == "run-windows-workspace":
            selected_workspace_profile = resolve_windows_workspace_backend_profile(
                args.workspace_frontend,
                args.workspace_backend_profile or "release",
            )
            selected_storage_profile = WINDOWS_WORKSPACE_STORAGE_PROFILES[selected_workspace_profile]
        elif args.action == "run-windows-workspace-build":
            if args.workspace_backend_profile not in WINDOWS_WORKSPACE_STORAGE_PROFILES:
                raise StorageError("Windows workspace build requires an explicit dev or release backend profile")
            selected_workspace_profile = args.workspace_backend_profile
            selected_storage_profile = WINDOWS_WORKSPACE_STORAGE_PROFILES[selected_workspace_profile]
        if selected_storage_profile:
            if args.profile and args.profile != selected_storage_profile:
                raise StorageError("Windows workspace storage profile does not match the selected compiler profile")
            layout = resolve_layout(args.repo_root, selected_storage_profile)
        else:
            layout = resolve_layout(args.repo_root, args.profile)
        if args.action == "assert-lock":
            if not os.environ.get("FULLMAG_STORAGE_LOCK_TOKEN") or os.environ.get("FULLMAG_STORAGE_LOCK_KEY") != layout["worktree_id"]:
                raise StorageError("No inherited managed lock; enter through the storage runner")
            with build_lock(layout):
                print(json.dumps({"locked": True, "worktree_id": layout["worktree_id"]}))
            return 0
        if args.action == "run":
            return run(layout, command)
        if args.action in ("run-windows-workspace", "run-windows-workspace-build"):
            if command:
                raise StorageError(f"{args.action} does not accept an arbitrary command")
            if args.workspace_frontend is None or args.workspace_web_port is None:
                raise StorageError(f"{args.action} requires --workspace-frontend and --workspace-web-port")
            if args.action == "run-windows-workspace-build":
                return run_windows_workspace_build(
                    layout,
                    args.workspace_frontend,
                    args.workspace_web_port,
                    selected_workspace_profile,
                    args.workspace_build_mode,
                    args.workspace_skip_local_changes,
                    args.workspace_request_id,
                )
            return run_windows_workspace(
                layout,
                args.workspace_frontend,
                args.workspace_web_port,
                args.workspace_build_mode,
                selected_workspace_profile,
                args.workspace_skip_local_changes,
            )
        if args.action == "prepare-links":
            print(json.dumps(prepare_links(layout, args.frontend, args.compat, args.next_dist_dir), indent=2))
            return 0
        if args.action == "validate":
            if not args.path:
                raise StorageError("validate requires --path")
            candidate = absolute(args.path, "output path")
            if not any(inside(candidate, Path(layout[key])) for key in ("storage_root", "build_storage_root")):
                raise StorageError(f"Output must stay in the resolved storage or validated build view: {candidate}")
            validate_managed_view(layout)
            print(candidate)
            return 0
        if args.action in ("register", "finish"):
            if not all((args.task_id, args.owner, args.purpose)):
                raise StorageError("register/finish requires --task-id, --owner and --purpose (reason/next step)")
            layout = register(layout, args.task_id, args.owner, args.purpose,
                              "active" if args.action == "register" else args.state)
        elif args.action == "inventory":
            layout = inventory(layout)
        elif args.create:
            initialize(layout)
        if args.format == "sh":
            if "env" not in layout:
                raise StorageError("--format sh is only available for resolve")
            for name, value in layout["env"].items():
                print(f"export {name}={shlex.quote(value)}")
        else:
            print(json.dumps(layout, indent=2, ensure_ascii=False))
        return 0
    except (StorageError, OSError, ValueError) as error:
        print(f"[fullmag storage] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
