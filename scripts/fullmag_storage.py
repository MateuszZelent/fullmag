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
# Native FEM is an explicitly bounded operation.  Keep these profiles separate
# from both the legacy Docker lane and the native FDM workspace profiles so a
# generic Windows command cannot acquire the native FEM heavy slot by accident.
WINDOWS_NATIVE_FEM_STORAGE_PROFILES = {
    "cpu": "windows-native-fem-cpu",
    "gpu": "windows-native-fem-gpu",
}
WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE = "windows-native-fem-gpu"
WINDOWS_INSTALLER_SOURCE_PROFILE = "windows-installer-source"
WINDOWS_NATIVE_BUILD_PROFILES = frozenset(WINDOWS_WORKSPACE_STORAGE_PROFILES.values()) | frozenset(
    WINDOWS_NATIVE_FEM_STORAGE_PROFILES.values()
) | frozenset({WINDOWS_INSTALLER_SOURCE_PROFILE})
WINDOWS_NATIVE_FEM_RECEIPT_SCHEMA = "fullmag.windows-native-fem-receipt.v1"
WINDOWS_FULL_WORKSPACE_RECEIPT_SCHEMA = "fullmag.windows-full-workspace-receipt.v1"
WINDOWS_FULL_WORKSPACE_COMPONENTS = {
    "fdm_cpu": ("fdm", "cpu", False, "native_fdm_dll"),
    "fdm_gpu": ("fdm", "gpu", True, "native_fdm_dll"),
    "fem_cpu": ("fem", "cpu", False, "native_fem_dll"),
    "fem_gpu": ("fem", "gpu", True, "native_fem_dll"),
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
    "FULLMAG_FRONTEND_CONTAINER_ROOT",
    "FULLMAG_WINDOWS_VOLATILE_ROOT",
}


class StorageError(RuntimeError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def _sha256_file(path):
    """Hash a file on both the managed Python 3.10 and 3.12 interpreters."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _directory_sha256(root):
    """Hash a static tree using the native Windows manifest algorithm.

    PowerShell hashes ``relative-posix-path|file-sha256`` records sorted by
    absolute path, with one trailing newline. Rejecting links while walking
    keeps a managed frontend tree from changing its meaning between the
    terminal build receipt and runtime admission.
    """
    root = Path(root)
    if is_link(root) or not root.is_dir():
        raise StorageError(f"Static frontend tree is not a regular directory: {root}")
    records = []
    for path in root.rglob("*"):
        if is_link(path):
            raise StorageError(f"Static frontend tree contains a symlink or junction: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise StorageError(f"Static frontend tree contains a non-file entry: {path}")
        relative = path.relative_to(root).as_posix()
        records.append((str(path), f"{relative}|{_sha256_file(path)}"))
    records.sort(key=lambda item: item[0].casefold())
    payload = ("".join(record + "\n" for _, record in records)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


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


def _assert_no_storage_dotenv_reparse(path):
    """Reject a dotenv file or parent that redirects before inspecting it."""
    for ancestor in (path, *path.parents):
        try:
            redirected = is_link(ancestor)
        except OSError as error:
            raise StorageError(f"Cannot safely inspect storage settings path: {path}") from error
        if redirected:
            raise StorageError(
                f"Storage settings file must not traverse a symlink/junction: {path} (at {ancestor})"
            )


def storage_dotenv(main_repo):
    """Read only storage settings; never execute or interpolate dotenv values."""
    path = main_repo / ".env"
    _assert_no_storage_dotenv_reparse(path)
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
    # Derive the shared project boundary from Git on every platform. Storage
    # and worktrees are siblings of the main checkout, regardless of cwd.
    project = main_repo.parent
    canonical_storage = project / "storage"
    profile = profile or env.get("FULLMAG_STORAGE_PROFILE") or ("windows-native" if os.name == "nt" else "linux-host")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", profile):
        raise StorageError(f"Invalid storage profile: {profile!r}")
    root = absolute(env.get("FULLMAG_PROJECT_STORAGE_ROOT", str(canonical_storage)), "FULLMAG_PROJECT_STORAGE_ROOT")
    if root == Path(root.anchor) or inside(project, root):
        raise StorageError(f"Storage cannot contain the project or be a filesystem root: {root}")
    if root in {Path(root.anchor) / name for name in ("fullmag-build", "fullmag-cache", "fullmag-tmp")}:
        raise StorageError(f"Legacy storage is not a destination for new builds: {root}")
    marker = root / ".fullmag-storage.json"
    if marker.exists():
        validate_path(marker, root, "storage marker")
        if json.loads(marker.read_text(encoding="utf-8")) != {"schema": SCHEMA, "project_root": str(project)}:
            raise StorageError(f"Storage marker belongs to another project or schema: {marker}")
    elif root != canonical_storage:
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
        # Bind sources are host paths, while Docker Desktop needs a Linux
        # target for a Windows checkout. Linux retains the absolute target
        # used by compatibility links.
        "FULLMAG_FRONTEND_CONTAINER_ROOT": (
            "/fullmag-frontend" if os.name == "nt" else layout["frontend_root"]
        ),
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


def _resolve_windows_fem_device(requested):
    if requested in ("cpu", "gpu"):
        return requested
    if requested != "auto":
        raise StorageError("Native FEM device must be auto, cpu or gpu")
    if not _is_native_windows():
        raise StorageError("Native FEM auto device resolution requires native Windows")
    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return "cpu"
    return "gpu" if result.returncode == 0 else "cpu"


def _validate_windows_fem_profile(layout, device):
    expected = WINDOWS_NATIVE_FEM_STORAGE_PROFILES.get(device)
    if expected is None or layout.get("profile") != expected:
        raise StorageError(
            "Native Windows FEM storage profile must match the resolved device "
            f"({device!r} requires {expected!r})"
        )


def _native_fem_receipt_path(layout):
    return validate_path(
        Path(layout["runtime_root"]) / "native-fem-receipt.json",
        layout["runtime_root"],
        "native FEM receipt",
    )


def _native_fem_receipt_attempt_path(layout, attempt_id):
    """Keep an immutable-per-attempt copy beside the compatibility alias."""
    if not isinstance(attempt_id, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt_id):
        raise StorageError("Native FEM receipt attempt id is invalid")
    return validate_path(
        Path(layout["runtime_root"]) / f"native-fem-receipt-{attempt_id}.json",
        layout["runtime_root"],
        "native FEM per-attempt receipt",
    )


def _persist_native_fem_attempt_receipt(layout, attempt_id, receipt):
    """Keep one attempt receipt immutable while allowing idempotent replay."""
    path = _native_fem_receipt_attempt_path(layout, attempt_id)
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError) as error:
            raise StorageError("Native FEM per-attempt receipt is unreadable") from error
        if existing != receipt:
            raise StorageError("Native FEM per-attempt receipt differs for the same attempt")
        return path
    atomic_json(path, receipt)
    return path


def _native_fem_receipt_status_matches(layout, status, receipt):
    """Only the terminal status for this attempt may advance the alias."""
    return (
        isinstance(status, dict)
        and status.get("schema") == SCHEMA
        and status.get("worktree_id") == layout["worktree_id"]
        and status.get("profile") == layout["profile"]
        and _same_path(status.get("repo_root"), layout["repo_root"])
        and status.get("attempt_id") == receipt.get("attempt_id")
        and status.get("execution_mode") == receipt.get("execution_mode")
        and status.get("state") == receipt.get("state")
        and status.get("exit_code") == receipt.get("exit_code")
        and status.get("build_manifest_sha256") == receipt.get("build_manifest_sha256")
        and status.get("execution_mode") in {
            "windows-fem", "windows-fem-build",
            "windows-fem-workspace", "windows-fem-workspace-build",
        }
        and status.get("state") in {"completed", "failed", "interrupted"}
    )


def _publish_native_fem_receipt(layout, receipt):
    """Persist every attempt and publish the shared alias under the build lock.

    The build status is the authoritative ordering record.  An older
    operation can reach its outer ``finally`` after a newer operation has
    released the lock; it keeps its own evidence but cannot regress the
    compatibility alias.
    """
    if not isinstance(receipt, dict) or receipt.get("schema") != WINDOWS_NATIVE_FEM_RECEIPT_SCHEMA:
        raise StorageError("Native FEM receipt schema is invalid")
    attempt_id = receipt.get("attempt_id")
    if (not isinstance(attempt_id, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt_id)
            or receipt.get("worktree_id") != layout["worktree_id"]
            or receipt.get("profile") != layout["profile"]):
        raise StorageError("Native FEM receipt belongs to another worktree or attempt")
    initialize(layout)
    # This path is unique to the attempt, so evidence survives even when
    # the shared alias has already advanced to a newer operation.
    _persist_native_fem_attempt_receipt(layout, attempt_id, receipt)
    try:
        with build_lock(layout):
            status_path = validate_path(
                Path(layout["build_root"]) / "build-status.json",
                layout["build_storage_root"],
                "native FEM build status",
            )
            try:
                status = json.loads(status_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                return False
            if not _native_fem_receipt_status_matches(layout, status, receipt):
                return False
            atomic_json(_native_fem_receipt_path(layout), receipt)
            return True
    except StorageError as error:
        # A newer managed operation may currently hold the same lock.
        # Its own terminal publication will advance the alias; never turn
        # an otherwise successful attempt into a stale-receipt failure.
        if str(error).startswith("Storage is busy:"):
            return False
        raise


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
        or layout.get("profile") not in WINDOWS_NATIVE_BUILD_PROFILES
    ):
        raise StorageError("Native user build requires one of the fixed Windows native profiles")
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
    def write_console(raw):
        stream = sys.stdout
        binary = getattr(stream, "buffer", None)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            if binary is not None:
                try:
                    # Native compiler code-page output stays byte tolerant;
                    # the binary file log is authoritative in either case.
                    binary.write(raw)
                    binary.flush()
                    return
                except (OSError, UnicodeError, ValueError):
                    pass
            text = raw.decode("utf-8", errors="replace")
        encoding = getattr(stream, "encoding", None) or "utf-8"
        try:
            # Re-encode through the console codec so replacement characters
            # cannot trigger UnicodeEncodeError on ASCII/cp1250 streams.
            safe = text.encode(encoding, errors="backslashreplace").decode(encoding, errors="replace")
        except (LookupError, UnicodeError):
            safe = text.encode("ascii", errors="replace").decode("ascii")
        try:
            stream.write(safe)
        except UnicodeEncodeError:
            stream.write(safe.encode("ascii", errors="replace").decode("ascii"))
        stream.flush()

    with log_path.open("xb") as log:
        if cancelled is not None and cancelled():
            raise StorageError("Native build cancelled before command launch")
        with subprocess.Popen(command, cwd=repo_root, env=child_env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
            for line in iter(child.stdout.readline, b""):
                log.write(line)
                log.flush()
                write_console(line)
            return subprocess.CompletedProcess(command, child.wait())


def _validate_expected_build_handoff(
    layout,
    command,
    *,
    native_workspace_paths,
    native_fem_paths,
    native_full_workspace_paths,
    native_manifest_relative,
    execution_mode,
):
    """Admit an ExpectedBuildId only when it pins this operation's manifest."""
    positions = [index for index, value in enumerate(command) if value == "-ExpectedBuildId"]
    if not positions:
        return
    if len(positions) != 1 or positions[0] + 1 >= len(command):
        raise StorageError("ExpectedBuildId must appear once with a manifest SHA256 value")
    expected = command[positions[0] + 1]
    if not isinstance(expected, str) or not SHA256_RE.fullmatch(expected):
        raise StorageError("ExpectedBuildId must be a lowercase manifest SHA256")
    if native_workspace_paths and execution_mode != "windows-workspace":
        raise StorageError("ExpectedBuildId is only valid for native workspace runtime")
    if native_fem_paths and execution_mode not in ("windows-fem", "windows-fem-workspace"):
        raise StorageError("ExpectedBuildId is only valid for native FEM runtime")
    if native_full_workspace_paths and execution_mode != "windows-full-workspace":
        raise StorageError("ExpectedBuildId is only valid for full workspace runtime")
    if sum(bool(value) for value in (
        native_workspace_paths, native_fem_paths, native_full_workspace_paths
    )) != 1:
        raise StorageError("ExpectedBuildId requires one closed native runtime lane")
    if native_full_workspace_paths:
        validate_full_workspace_handoff(layout, expected)
        return
    manifest = validate_path(
        Path(layout["build_root"]) / (native_manifest_relative or "windows-runtime/build-manifest.json"),
        layout["build_root"],
        "native build manifest",
    )
    if not manifest.is_file():
        raise StorageError("ExpectedBuildId refers to a missing native build manifest")
    if _sha256_file(manifest) != expected:
        raise StorageError("ExpectedBuildId does not match the native build manifest")


def _run_managed_command(
    layout,
    command,
    *,
    acquire_heavy_slot=True,
    native_user_build=False,
    native_workspace_paths=False,
    native_fem_paths=False,
    native_full_workspace_paths=False,
    fem_browser_workspace=False,
    native_installer_paths=False,
    workspace_backend_profile=None,
    fem_device=None,
    fem_requested_device=None,
    execution_mode="managed",
    result_record=None,
    workspace_request_id=None,
    native_manifest_relative=None,
    attempt_id=None,
    fem_frontend=None,
    full_origin_attempt_id=None,
):
    if attempt_id is None:
        attempt_id = uuid.uuid4().hex
    elif not isinstance(attempt_id, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt_id):
        raise StorageError("Managed command attempt id must be a 32-character lowercase hex value")
    if workspace_request_id is not None:
        workspace_request_id = validate_workspace_request_id(workspace_request_id)
        if not (
            native_user_build
            and native_workspace_paths
            and execution_mode == "windows-workspace-build"
        ):
            raise StorageError("Workspace request ids are only valid for the closed Windows workspace build operation")
    if native_workspace_paths:
        _validate_windows_workspace_profile(layout, workspace_backend_profile)
        if not _is_native_windows() or execution_mode not in (
            "windows-workspace",
            "windows-workspace-build",
        ):
            raise StorageError("Native workspace paths require the fixed Windows workspace operation")
        if native_user_build and execution_mode != "windows-workspace-build":
            raise StorageError("Native user builds require the closed Windows workspace build operation")
    if native_fem_paths:
        if not _is_native_windows() or execution_mode not in (
            "windows-fem",
            "windows-fem-build",
            "windows-fem-workspace",
            "windows-fem-workspace-build",
        ):
            raise StorageError("Native FEM paths require the fixed Windows FEM operation")
        if fem_device not in WINDOWS_NATIVE_FEM_STORAGE_PROFILES:
            raise StorageError("Native FEM operation requires a resolved cpu or gpu device")
        _validate_windows_fem_profile(layout, fem_device)
        if native_user_build and execution_mode not in (
            "windows-fem", "windows-fem-build", "windows-fem-workspace-build"
        ):
            raise StorageError("Native FEM builds require the closed Windows FEM operation")
    if native_full_workspace_paths:
        if (
            not _is_native_windows()
            or execution_mode not in ("windows-full-workspace", "windows-full-workspace-build")
            or layout.get("profile") != WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE
            or "-AllBackends" not in command
            or "-Browser" not in command
        ):
            raise StorageError("Full workspace paths require the closed all-realizations browser operation")
        if native_user_build and execution_mode != "windows-full-workspace-build":
            raise StorageError("Full workspace builds require the closed build operation")
        if full_origin_attempt_id is not None and not re.fullmatch(r"[0-9a-f]{32}", full_origin_attempt_id):
            raise StorageError("Full workspace origin attempt identity is malformed")
    if fem_browser_workspace:
        if (not native_fem_paths
                or execution_mode not in ("windows-fem-workspace", "windows-fem-workspace-build")
                or "-Browser" not in command):
            raise StorageError("FEM browser workspace requires the closed browser operation")
    if native_installer_paths:
        if (not _is_native_windows()
                or execution_mode != "windows-installer-source-build"
                or layout.get("profile") != WINDOWS_INSTALLER_SOURCE_PROFILE
                or not native_user_build
                or native_workspace_paths or native_fem_paths):
            raise StorageError("Installer source builds require the closed native Windows installer operation")
    if native_user_build and not (
        native_workspace_paths or native_fem_paths or native_full_workspace_paths or native_installer_paths
    ):
        raise StorageError("Native user builds require a closed native Windows operation")
    if not command:
        raise StorageError("A command is required after --")
    _validate_expected_build_handoff(
        layout,
        command,
        native_workspace_paths=native_workspace_paths,
        native_fem_paths=native_fem_paths,
        native_full_workspace_paths=native_full_workspace_paths,
        native_manifest_relative=native_manifest_relative,
        execution_mode=execution_mode,
    )
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
        # Recheck the full handoff after acquiring the build lock.  The early
        # admission check rejects stale input quickly; this check closes the
        # cooperative writer window before the child process is spawned.
        if native_full_workspace_paths:
            _validate_expected_build_handoff(
                layout,
                command,
                native_workspace_paths=native_workspace_paths,
                native_fem_paths=native_fem_paths,
                native_full_workspace_paths=native_full_workspace_paths,
                native_manifest_relative=native_manifest_relative,
                execution_mode=execution_mode,
            )
        request_receipt_path = None
        if workspace_request_id is not None:
            request_receipt_path = _workspace_build_request_receipt_path(
                layout, workspace_request_id, create_parent=True
            )
            if os.path.lexists(request_receipt_path):
                raise StorageError("Workspace build request id already has a receipt; request ids cannot be replayed")
        child_env = {**os.environ, **layout["env"]}
        if native_installer_paths:
            child_env["FULLMAG_INSTALLER_ATTEMPT_ID"] = attempt_id
        if native_fem_paths:
            requested_device = fem_requested_device or fem_device
            if requested_device not in ("auto", "cpu", "gpu"):
                raise StorageError("Native FEM requested device must be auto, cpu or gpu")
            child_env["FULLMAG_FEM_REQUESTED_DEVICE"] = requested_device
            child_env["FULLMAG_NATIVE_FEM_ATTEMPT_ID"] = attempt_id
        if native_full_workspace_paths:
            child_env["FULLMAG_FEM_REQUESTED_DEVICE"] = "auto"
            child_env["FULLMAG_NATIVE_FEM_ATTEMPT_ID"] = full_origin_attempt_id or attempt_id
        if native_user_build or native_fem_paths or native_full_workspace_paths:
            # The PowerShell child is entered only from this closed operation;
            # the storage token below is installed by build_lock before spawn.
            # Keep the managed sentinel out of the caller environment so an
            # unleased direct launcher cannot impersonate this boundary.
            child_env["FULLMAG_STORAGE_MANAGED_ENTRY"] = "1"
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
        if not (native_workspace_paths or native_installer_paths):
            validate_prepared_links_for_run(layout)
        record = validate_path(Path(layout["build_root"]) / "build-status.json", layout["build_storage_root"], "build status")
        validate_existing_build_status(record, layout)
        state = {"schema": SCHEMA, "worktree_id": layout["worktree_id"], "profile": layout["profile"],
                 "repo_root": layout["repo_root"], "head": git(layout["repo_root"], "rev-parse", "HEAD"),
                 "source_dirty": bool(git(layout["repo_root"], "status", "--porcelain", "--untracked-files=normal")),
                 "pid": os.getpid(), "host": socket.gethostname(), "attempt_id": attempt_id,
                 "started_at": now(),
                 "state": "running", "executable": Path(command[0]).name,
                 "build_root": layout["build_root"], "frontend_root": layout["frontend_root"],
                 "runtime_root": layout["runtime_root"], "qualification": "not_assessed",
                 "execution_mode": execution_mode}
        atomic_json(record, state)
        try:
            if cancel_check is not None and cancel_check():
                raise StorageError("Native build cancelled before command launch")
            if native_user_build or native_fem_paths or native_full_workspace_paths:
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
            if (native_user_build or native_fem_paths or native_full_workspace_paths) and result.returncode == 0:
                manifest_relative = native_manifest_relative or (
                    "windows-runtime/build-manifest.json"
                )
                manifest = validate_path(
                    Path(layout["build_root"]) / manifest_relative,
                    layout["build_root"],
                    "Windows native build manifest",
                )
                if manifest.is_file():
                    raw_manifest = manifest.read_bytes()
                    if native_full_workspace_paths:
                        try:
                            full_manifest = json.loads(raw_manifest)
                            expected_full_attempt = full_origin_attempt_id or attempt_id
                            if (
                                not isinstance(full_manifest, dict)
                                or full_manifest.get("attempt_id") != expected_full_attempt
                            ):
                                raise StorageError(
                                    "Full workspace manifest belongs to a different managed attempt"
                                )
                            expected_full_build_id = None
                            if execution_mode == "windows-full-workspace":
                                try:
                                    expected_position = command.index("-ExpectedBuildId")
                                except ValueError as error:
                                    raise StorageError(
                                        "Full workspace runtime completed without ExpectedBuildId"
                                    ) from error
                                expected_full_build_id = command[expected_position + 1]
                            validate_full_workspace_manifest(
                                layout,
                                full_manifest,
                                expected_build_id=expected_full_build_id,
                            )
                            if execution_mode == "windows-full-workspace-build":
                                receipt_path, receipt_hash = _persist_full_workspace_receipt(
                                    layout, full_manifest, execution_mode, state
                                )
                                state["full_receipt_path"] = str(receipt_path)
                                state["full_receipt_sha256"] = receipt_hash
                        except (StorageError, OSError, ValueError, TypeError):
                            print("[fullmag storage] Full workspace manifest or receipt validation failed", file=sys.stderr)
                            state.update(state="failed", exit_code=1)
                            terminal_returncode = 1
                    elif native_fem_paths:
                        try:
                            validate_fem_terminal_manifest(
                                layout, json.loads(raw_manifest), fem_device,
                                fem_requested_device or fem_device,
                                attempt_id if native_user_build else None,
                                browser_workspace=fem_browser_workspace,
                                browser_frontend=fem_frontend,
                            )
                        except (StorageError, OSError, ValueError, TypeError):
                            print("[fullmag storage] Native FEM terminal manifest or artifact validation failed", file=sys.stderr)
                            state.update(state="failed", exit_code=1)
                            terminal_returncode = 1
                    if terminal_returncode == 0:
                        state["build_manifest_sha256"] = hashlib.sha256(raw_manifest).hexdigest()
                    if native_installer_paths:
                        try:
                            validate_installer_terminal_manifest(layout, json.loads(raw_manifest), attempt_id)
                        except (StorageError, ValueError, TypeError):
                            print("[fullmag storage] Installer terminal manifest or artifact validation failed", file=sys.stderr)
                            state.update(state="failed", exit_code=1)
                            terminal_returncode = 1
                elif workspace_request_id is not None or native_fem_paths or native_full_workspace_paths or native_installer_paths:
                    # A successful compiler/runtime exit is not ready until the
                    # exact terminal manifest can be pinned to this operation.
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



def _validate_fem_browser_frontend(layout, manifest, requested_frontend):
    """Validate the source-first browser surface independently of the solver DLL."""
    if manifest.get("browser_workspace") is not True:
        raise StorageError("Native FEM manifest is missing the browser workspace marker")
    if requested_frontend not in ("static", "dev"):
        raise StorageError("Native FEM browser validation requires the requested frontend mode")
    if (manifest.get("ui_host") != "browser"
            or manifest.get("workspace_mode") != "empty"
            or manifest.get("desktop_binary") is not None
            or manifest.get("desktop_binary_sha256") is not None):
        raise StorageError("Native FEM manifest is not an empty browser workspace build")
    frontend_mode = manifest.get("frontend_mode")
    if frontend_mode != requested_frontend:
        raise StorageError("Native FEM browser manifest frontend does not match the requested frontend mode")
    build_root = Path(layout["build_root"])
    workspace = validate_path(
        manifest.get("frontend_workspace_root", ""), build_root,
        "native FEM browser frontend workspace",
    )
    cache = validate_path(
        manifest.get("frontend_cache_root", ""), build_root,
        "native FEM browser frontend cache",
    )
    if not workspace.is_dir() or not cache.is_dir():
        raise StorageError("Native FEM browser frontend roots are missing")
    source_manifest = validate_path(
        manifest.get("frontend_source_manifest", ""), build_root,
        "native FEM browser frontend source manifest",
    )
    expected_source_hash = manifest.get("frontend_source_manifest_sha256")
    if (not source_manifest.is_file() or source_manifest.stat().st_size == 0
            or not isinstance(expected_source_hash, str)
            or not SHA256_RE.fullmatch(expected_source_hash)):
        raise StorageError("Native FEM browser frontend source manifest is missing or unhashed")
    if _sha256_file(source_manifest) != expected_source_hash:
        raise StorageError("Native FEM browser frontend source manifest changed")
    app_root = validate_path(
        workspace / "apps" / "control-room", workspace,
        "native FEM browser frontend application",
    )
    # The staged app deliberately contains managed links for generated output;
    # validate the static entry through its already-validated cache root rather
    # than following an arbitrary reparse point from the source mirror.
    entry = (cache / "out" / "index.html") if frontend_mode == "static" else (app_root / "dev-server.mjs")
    entry = validate_path(entry, cache if frontend_mode == "static" else workspace,
                          "native FEM browser frontend entry")
    expected_entry_hash = manifest.get("frontend_entry_sha256")
    if (str(manifest.get("frontend_entry_path", "")) != str(entry)
            or not entry.is_file() or entry.stat().st_size == 0
            or not isinstance(expected_entry_hash, str)
            or not SHA256_RE.fullmatch(expected_entry_hash)):
        raise StorageError("Native FEM browser frontend entry is missing or unhashed")
    if _sha256_file(entry) != expected_entry_hash:
        raise StorageError("Native FEM browser frontend entry changed")
    if frontend_mode == "static":
        static_root = validate_path(
            cache / "out", cache, "native FEM browser static frontend tree",
        )
        expected_static_hash = manifest.get("static_web_sha256")
        if (not isinstance(expected_static_hash, str)
                or not SHA256_RE.fullmatch(expected_static_hash)):
            raise StorageError("Native FEM browser static frontend tree is missing or unhashed")
        if _directory_sha256(static_root) != expected_static_hash:
            raise StorageError("Native FEM browser static frontend tree changed")


def validate_fem_terminal_manifest(
    layout, manifest, device, requested_device, attempt_id=None, *, browser_workspace=False,
    browser_frontend=None,
):
    """Admit only complete, device-correct native FEM output from this build."""
    if not isinstance(manifest, dict):
        raise StorageError("Native FEM manifest must be an object")
    fem = manifest.get("native_fem")
    if (manifest.get("schema_version") != 1
            or manifest.get("state") != "completed"
            or manifest.get("backend") != "fem"
            or manifest.get("target_triple") != "x86_64-pc-windows-msvc"
            or manifest.get("cuda") is not (device == "gpu")
            or not isinstance(fem, dict)
            or fem.get("device") != device
            or fem.get("requested_device") != requested_device
            or fem.get("strict_gpu") is not (device == "gpu")):
        raise StorageError("Native FEM manifest has incompatible completion or device provenance")
    if browser_workspace:
        _validate_fem_browser_frontend(layout, manifest, browser_frontend)
    manifest_attempt = manifest.get("native_fem_attempt_id")
    if (not isinstance(manifest_attempt, str)
            or not re.fullmatch(r"[0-9a-f]{32}", manifest_attempt)
            or (attempt_id is not None and manifest_attempt != attempt_id)):
        raise StorageError("Native FEM manifest belongs to another build attempt")
    for owner, path_key, hash_key in (
            (manifest, "binary", "binary_sha256"),
            (manifest, "api_binary", "api_binary_sha256"),
            (fem, "runtime_dll", "runtime_dll_sha256"),
            (fem, "dependency_audit_path", "dependency_audit_sha256"),
            (fem, "provider_config", "provider_config_sha256"),
            (fem, "provider_receipt_path", "provider_receipt_sha256")):
        expected = owner.get(hash_key)
        if not isinstance(expected, str) or not SHA256_RE.fullmatch(expected):
            raise StorageError("Native FEM manifest is missing an artifact hash")
        artifact_root = Path(layout["build_root"])
        if path_key in ("provider_config", "provider_receipt_path"):
            artifact_root /= "fem-dependencies"
            if path_key == "provider_config":
                artifact_root /= "installed"
        artifact = validate_path(owner.get(path_key, ""), artifact_root, "Native FEM artifact")
        if path_key == "provider_receipt_path" and artifact != artifact_root / "provider-receipt.json":
            raise StorageError("Native FEM provider receipt path is not canonical")
        if not artifact.is_file() or artifact.stat().st_size == 0:
            raise StorageError("Native FEM artifact is missing or changed")
        actual = _sha256_file(artifact)
        if actual != expected:
            raise StorageError("Native FEM artifact is missing or changed")


def _full_workspace_manifest_path(layout):
    return validate_path(
        Path(layout["build_root"]) / "windows-full-runtime" / "build-manifest.json",
        layout["build_root"],
        "full workspace manifest",
    )


def _full_workspace_receipt_path(layout, attempt_id):
    if not isinstance(attempt_id, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt_id):
        raise StorageError("Full workspace receipt attempt id is invalid")
    receipt_root = validate_path(
        Path(layout["build_root"]) / "windows-full-runtime" / "receipts",
        layout["build_root"],
        "full workspace receipt root",
    )
    return validate_path(
        receipt_root / f"{attempt_id}.json",
        layout["build_root"],
        "full workspace receipt",
    )


def _full_workspace_file(value, root, label, expected_hash=None):
    if not isinstance(value, str) or not value:
        raise StorageError(f"{label} path is missing")
    try:
        path = validate_path(value, root, label)
    except (StorageError, TypeError, ValueError) as error:
        raise StorageError(f"{label} path is invalid") from error
    if not path.is_file() or is_link(path) or path.stat().st_size <= 0:
        raise StorageError(f"{label} is missing or is not a regular file")
    if expected_hash is not None:
        if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
            raise StorageError(f"{label} hash is missing or malformed")
        if _sha256_file(path) != expected_hash:
            raise StorageError(f"{label} hash does not match its manifest")
    return path


def _full_workspace_hash(value, label):
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise StorageError(f"{label} hash is missing or malformed")
    return value


def _full_workspace_artifacts(value, root, expected_paths, label):
    if not isinstance(value, list) or len(value) != len(expected_paths):
        raise StorageError(f"{label} artifact inventory is incomplete")
    observed = []
    for index, artifact in enumerate(value):
        if not isinstance(artifact, dict):
            raise StorageError(f"{label} artifact record is invalid")
        path = _full_workspace_file(
            artifact.get("path"), root, f"{label} artifact {index}", artifact.get("sha256")
        )
        size = artifact.get("size_bytes")
        if type(size) is not int or size <= 0 or size != path.stat().st_size:
            raise StorageError(f"{label} artifact size is invalid")
        digest = _full_workspace_hash(artifact.get("sha256"), f"{label} artifact {index}")
        observed.append((path, size, digest))
    for expected_path, expected_size, expected_digest in expected_paths:
        matches = [
            item for item in observed
            if _same_path(item[0], expected_path)
            and item[1] == expected_size
            and item[2] == expected_digest
        ]
        if len(matches) != 1:
            raise StorageError(f"{label} artifact inventory does not match the package")
    return observed


def validate_full_workspace_manifest(layout, manifest, *, expected_build_id=None):
    """Validate the four-capability package and its strict FEM GPU origin.

    The aggregate manifest is a capability package, not a FEM receipt.  Every
    component record, component manifest, component receipt and artifact hash
    is checked against the same immutable strict FEM GPU origin attempt.
    """
    if not isinstance(manifest, dict):
        raise StorageError("Full workspace manifest must be an object")
    if (
        manifest.get("schema") != "fullmag.windows-full-capability-package.v1"
        or manifest.get("state") != "completed"
        or manifest.get("profile") != WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE
        or manifest.get("requested_backend") != "auto"
        or manifest.get("requested_device") != "auto"
        or manifest.get("runtime_selection") != "ui"
    ):
        raise StorageError("Full workspace manifest has an invalid package identity")
    if expected_build_id is not None:
        _full_workspace_hash(expected_build_id, "full workspace manifest")

    attempt_id = manifest.get("attempt_id")
    if not isinstance(attempt_id, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt_id):
        raise StorageError("Full workspace manifest attempt identity is malformed")
    source_identity = manifest.get("source_identity")
    source_snapshot = manifest.get("source_snapshot_sha256")
    if (
        not isinstance(source_identity, dict)
        or not isinstance(source_identity.get("head_commit_full"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", source_identity["head_commit_full"])
        or not isinstance(source_identity.get("source_worktree_state"), str)
        or not isinstance(source_snapshot, str)
        or not SHA256_RE.fullmatch(source_snapshot)
        or source_identity.get("source_snapshot_sha256") != source_snapshot
    ):
        raise StorageError("Full workspace source identity is malformed")

    build_root = Path(layout["build_root"])
    origin_path = _full_workspace_file(
        manifest.get("origin_manifest_path"), build_root, "full workspace origin manifest",
        manifest.get("origin_manifest_sha256"),
    )
    expected_origin_path = validate_path(
        build_root / "windows-fem-runtime" / "build-manifest.json",
        build_root,
        "full workspace fixed origin manifest",
    )
    if not _same_path(origin_path, expected_origin_path):
        raise StorageError("Full workspace origin manifest is not the canonical FEM build manifest")
    try:
        origin = json.loads(origin_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        raise StorageError("Full workspace origin manifest is unreadable") from error
    origin_fem = origin.get("native_fem") if isinstance(origin, dict) else None
    if (
        not isinstance(origin, dict)
        or origin.get("schema_version") != 1
        or origin.get("state") != "completed"
        or origin.get("backend") != "fem"
        or origin.get("cuda") is not True
        or not isinstance(origin_fem, dict)
        or origin_fem.get("device") != "gpu"
        or origin_fem.get("requested_device") != "auto"
        or origin_fem.get("strict_gpu") is not True
        or origin.get("native_fem_attempt_id") != attempt_id
        or origin.get("source_commit_after") != source_identity["head_commit_full"]
        or origin.get("source_worktree_state_after") != source_identity["source_worktree_state"]
        or origin.get("source_snapshot_sha256_after") != source_snapshot
    ):
        raise StorageError("Full workspace origin is not the requested strict FEM GPU attempt")
    # Reuse the lane-specific validator for the origin's binaries, provider
    # receipt and browser frontend, but never publish or consume its FEM alias.
    validate_fem_terminal_manifest(
        layout,
        origin,
        "gpu",
        "auto",
        attempt_id,
        browser_workspace=True,
        browser_frontend="static",
    )

    if expected_build_id is not None:
        manifest_path = _full_workspace_manifest_path(layout)
        if not manifest_path.is_file() or _sha256_file(manifest_path) != expected_build_id:
            raise StorageError("ExpectedBuildId does not match the full workspace manifest")

    top_artifacts = {}
    for field, hash_field, label in (
        ("binary", "binary_sha256", "full workspace executable"),
        ("api_binary", "api_binary_sha256", "full workspace API executable"),
        ("native_fdm_dll", "native_fdm_dll_sha256", "full workspace native FDM DLL"),
        ("native_fem_dll", "native_fem_dll_sha256", "full workspace native FEM DLL"),
    ):
        digest = _full_workspace_hash(manifest.get(hash_field), label)
        top_artifacts[field] = _full_workspace_file(manifest.get(field), build_root, label, digest)
    origin_binary = _full_workspace_file(origin.get("binary"), build_root, "full workspace origin executable", origin.get("binary_sha256"))
    origin_api = _full_workspace_file(origin.get("api_binary"), build_root, "full workspace origin API executable", origin.get("api_binary_sha256"))
    origin_fem = origin.get("native_fem")
    origin_fem_dll = _full_workspace_file(
        origin_fem.get("runtime_dll") if isinstance(origin_fem, dict) else None,
        build_root,
        "full workspace origin FEM DLL",
        origin_fem.get("runtime_dll_sha256") if isinstance(origin_fem, dict) else None,
    )
    origin_fdm_dll = _full_workspace_file(
        origin.get("native_fdm_dll"), build_root, "full workspace origin FDM DLL"
    )
    for aggregate_field, origin_artifact_path in (
        ("binary", origin_binary),
        ("api_binary", origin_api),
        ("native_fdm_dll", origin_fdm_dll),
        ("native_fem_dll", origin_fem_dll),
    ):
        if not _same_path(top_artifacts[aggregate_field], origin_artifact_path) or _sha256_file(top_artifacts[aggregate_field]) != _sha256_file(origin_artifact_path):
            raise StorageError(f"Full workspace aggregate artifact is not bound to its origin: {aggregate_field}")
    runtime_environment = manifest.get("runtime_environment")
    if (
        not isinstance(runtime_environment, dict)
        or set(runtime_environment) != {
            "FULLMAG_FDM_EXECUTION", "FULLMAG_FEM_EXECUTION", "FULLMAG_RELAX_DEVICE"
        }
        or any(runtime_environment[name] is not None for name in runtime_environment)
    ):
        raise StorageError("Full workspace manifest must leave runtime selection variables unset")

    components = manifest.get("components")
    if not isinstance(components, dict) or set(components) != set(WINDOWS_FULL_WORKSPACE_COMPONENTS):
        raise StorageError("Full workspace manifest must contain exactly four components")
    component_root = validate_path(
        build_root / "windows-full-runtime" / "components" / attempt_id,
        build_root,
        "full workspace component attempt root",
    )
    for component, (backend, device, needs_driver, artifact_field) in WINDOWS_FULL_WORKSPACE_COMPONENTS.items():
        record = components.get(component)
        if not isinstance(record, dict):
            raise StorageError(f"Full workspace component record is invalid: {component}")
        if (
            record.get("backend") != backend
            or record.get("device") != device
            or record.get("installed_support") is not True
            or record.get("requires_nvidia_driver") is not needs_driver
        ):
            raise StorageError(f"Full workspace component identity is invalid: {component}")
        component_manifest_path = _full_workspace_file(
            record.get("component_manifest_path"), build_root,
            f"{component} component manifest", record.get("component_manifest_sha256"),
        )
        receipt_path = _full_workspace_file(
            record.get("receipt_path"), build_root,
            f"{component} receipt", record.get("receipt_sha256"),
        )
        expected_component_manifest_path = component_root / f"{component}.manifest.json"
        expected_receipt_path = component_root / f"{component}.receipt.json"
        if (
            not _same_path(component_manifest_path, expected_component_manifest_path)
            or not _same_path(receipt_path, expected_receipt_path)
        ):
            raise StorageError(f"Full workspace component metadata escapes its immutable attempt directory: {component}")
        try:
            component_manifest = json.loads(component_manifest_path.read_text(encoding="utf-8"))
            component_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError, TypeError) as error:
            raise StorageError(f"Full workspace component metadata is unreadable: {component}") from error
        if (
            not isinstance(component_manifest, dict)
            or component_manifest.get("schema") != "fullmag.windows-runtime-component.v1"
            or component_manifest.get("component") != component
            or component_manifest.get("backend") != backend
            or component_manifest.get("device") != device
            or component_manifest.get("installed_support") is not True
            or component_manifest.get("requires_nvidia_driver") is not needs_driver
            or not _same_path(component_manifest.get("origin_manifest_path", ""), origin_path)
            or component_manifest.get("origin_manifest_sha256") != manifest.get("origin_manifest_sha256")
            or component_manifest.get("source_identity") != source_identity
            or component_manifest.get("source_snapshot_sha256") != source_snapshot
            or component_manifest.get("attempt_id") != attempt_id
            or not _same_path(component_manifest.get("receipt_path", ""), receipt_path)
        ):
            raise StorageError(f"Full workspace component manifest is not bound: {component}")
        if (
            not isinstance(component_receipt, dict)
            or component_receipt.get("schema") != "fullmag.windows-runtime-component-receipt.v1"
            or component_receipt.get("component") != component
            or component_receipt.get("backend") != backend
            or component_receipt.get("device") != device
            or component_receipt.get("installed_support") is not True
            or component_receipt.get("requires_nvidia_driver") is not needs_driver
            or not _same_path(component_receipt.get("component_manifest_path", ""), component_manifest_path)
            or component_receipt.get("component_manifest_sha256") != record.get("component_manifest_sha256")
            or not _same_path(component_receipt.get("origin_manifest_path", ""), origin_path)
            or component_receipt.get("origin_manifest_sha256") != manifest.get("origin_manifest_sha256")
            or component_receipt.get("source_snapshot_sha256") != source_snapshot
            or component_receipt.get("attempt_id") != attempt_id
        ):
            raise StorageError(f"Full workspace component receipt is not bound: {component}")
        expected_artifacts = []
        for artifact_path in (top_artifacts["binary"], top_artifacts["api_binary"], top_artifacts[artifact_field]):
            expected_artifacts.append((artifact_path, artifact_path.stat().st_size, _sha256_file(artifact_path)))
        manifest_artifacts = _full_workspace_artifacts(
            component_manifest.get("artifacts"), build_root, expected_artifacts,
            f"{component} component manifest",
        )
        record_artifacts = _full_workspace_artifacts(
            record.get("artifacts"), build_root, expected_artifacts,
            f"{component} component record",
        )
        if sorted((str(path), size, digest) for path, size, digest in manifest_artifacts) != sorted(
            (str(path), size, digest) for path, size, digest in record_artifacts
        ):
            raise StorageError(f"Full workspace component record differs from its manifest: {component}")
    return manifest


def _persist_full_workspace_receipt(layout, manifest, execution_mode, state):
    """Write a terminal full-package receipt once for this build attempt."""
    attempt_id = manifest.get("attempt_id")
    path = _full_workspace_receipt_path(layout, attempt_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Re-resolve after creating the receipt directory so a newly materialized
    # ancestor cannot turn the immutable per-attempt namespace into a reparse
    # point between the preflight and the atomic write.
    path = _full_workspace_receipt_path(layout, attempt_id)
    receipt = {
        "schema": WINDOWS_FULL_WORKSPACE_RECEIPT_SCHEMA,
        "state": "completed",
        "exit_code": 0,
        "worktree_id": layout["worktree_id"],
        "profile": layout["profile"],
        "execution_mode": execution_mode,
        "attempt_id": attempt_id,
        "manifest_path": str(_full_workspace_manifest_path(layout)),
        "manifest_sha256": _sha256_file(_full_workspace_manifest_path(layout)),
        "origin_manifest_path": manifest["origin_manifest_path"],
        "origin_manifest_sha256": manifest["origin_manifest_sha256"],
        "source_identity": manifest["source_identity"],
        "source_snapshot_sha256": manifest["source_snapshot_sha256"],
        "components": manifest["components"],
        "started_at": state.get("started_at"),
        "finished_at": now(),
    }
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError, TypeError) as error:
            raise StorageError("Full workspace receipt is unreadable") from error
        if existing != receipt:
            raise StorageError("Full workspace receipt differs for the same build attempt")
    else:
        atomic_json(path, receipt)
    return path, _sha256_file(path)


def validate_full_workspace_handoff(layout, expected_build_id):
    """Validate a runtime's manifest and immutable per-attempt receipt."""
    _full_workspace_hash(expected_build_id, "full workspace ExpectedBuildId")
    manifest_path = _full_workspace_manifest_path(layout)
    if not manifest_path.is_file() or _sha256_file(manifest_path) != expected_build_id:
        raise StorageError("ExpectedBuildId does not match the full workspace manifest")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        raise StorageError("Full workspace manifest is unreadable") from error
    validate_full_workspace_manifest(layout, manifest, expected_build_id=expected_build_id)
    receipt_path = _full_workspace_receipt_path(layout, manifest["attempt_id"])
    if not receipt_path.is_file():
        raise StorageError("Full workspace build has no immutable per-attempt receipt")
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        raise StorageError("Full workspace receipt is unreadable") from error
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema") != WINDOWS_FULL_WORKSPACE_RECEIPT_SCHEMA
        or receipt.get("state") != "completed"
        or receipt.get("exit_code") != 0
        or receipt.get("worktree_id") != layout["worktree_id"]
        or receipt.get("profile") != WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE
        or receipt.get("execution_mode") != "windows-full-workspace-build"
        or receipt.get("attempt_id") != manifest["attempt_id"]
        or receipt.get("manifest_sha256") != expected_build_id
        or not _same_path(receipt.get("manifest_path", ""), manifest_path)
        or receipt.get("origin_manifest_sha256") != manifest.get("origin_manifest_sha256")
        or receipt.get("source_identity") != manifest.get("source_identity")
        or receipt.get("source_snapshot_sha256") != manifest.get("source_snapshot_sha256")
        or receipt.get("components") != manifest.get("components")
    ):
        raise StorageError("Full workspace receipt is stale or not bound to the requested manifest")
    return manifest


def validate_installer_terminal_manifest(layout, manifest, attempt_id):
    """Reject stale installer receipts and changed or misplaced public artifacts."""
    if (manifest.get("schema") != "fullmag.windows-installer-source-build.v1"
            or manifest.get("state") != "completed"
            or manifest.get("profile") != WINDOWS_INSTALLER_SOURCE_PROFILE
            or manifest.get("attempt_id") != attempt_id):
        raise StorageError("Installer terminal manifest does not belong to this managed attempt")
    artifact = validate_path(manifest.get("artifact", ""), layout["runs_root"], "installer artifact")
    expected_hash = manifest.get("artifact_sha256", "")
    if (artifact.name != "fullmag.exe" or not artifact.is_file()
            or not isinstance(expected_hash, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)
            or hashlib.sha256(artifact.read_bytes()).hexdigest() != expected_hash):
        raise StorageError("Installer terminal artifact is missing or its hash differs")


def run_windows_installer_source(layout):
    """Compile only the fixed installer producer under the native heavy lease."""
    if not _is_native_windows() or layout.get("profile") != WINDOWS_INSTALLER_SOURCE_PROFILE:
        raise StorageError("Installer source builds require native Windows and the fixed installer profile")
    producer = validate_path(
        Path(layout["repo_root"]) / "scripts" / "windows" / "build_installer_from_source.ps1",
        layout["repo_root"], "Windows installer source producer",
    )
    if not producer.is_file():
        raise StorageError("Windows installer source producer is missing")
    return _run_managed_command(
        layout,
        ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
         "-ExecutionPolicy", "Bypass", "-File", str(producer), "-ManagedBuild"],
        native_user_build=True, native_installer_paths=True,
        execution_mode="windows-installer-source-build",
        native_manifest_relative="installer-source/build-manifest.json",
    )


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
        if not skip_local_changes:
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



def run_windows_fem(
    layout,
    frontend,
    device,
    run_mode,
    script_path=None,
    output_dir=None,
    web_port=0,
    build_mode="false",
    build_only=False,
    skip_local_changes=False,
    expected_build_id=None,
):
    """Run one native Windows FEM build/solve through a closed operation.

    The resolver owns profile selection, the native heavy slot and the
    terminal build manifest.  The PowerShell child only receives the bounded
    arguments below; arbitrary commands remain on ``run`` and are rejected for
    native Windows profiles by the heavy-slot guard.
    """
    if not _is_native_windows():
        raise StorageError("Native Windows FEM requires native Windows")
    if frontend not in ("static", "dev"):
        raise StorageError("Native FEM frontend must be static or dev")
    if device not in ("auto", "cpu", "gpu"):
        raise StorageError("Native FEM device must be auto, cpu or gpu")
    if run_mode not in ("interactive", "headless"):
        raise StorageError("Native FEM run mode must be interactive or headless")
    if build_mode not in ("true", "false"):
        raise StorageError("Native FEM build mode must be true or false")
    if expected_build_id is not None and not SHA256_RE.fullmatch(expected_build_id):
        raise StorageError("Native FEM expected build id must be a lowercase manifest SHA256")
    if expected_build_id is not None and build_mode != "false":
        raise StorageError("Native FEM expected build id is only valid for runtime")
    if type(web_port) is not int or not 0 <= web_port <= 65535:
        raise StorageError("Native FEM web port must be an integer from 0 to 65535")
    if build_only and not build_mode == "true":
        raise StorageError("Native FEM build-only requires build mode true")
    if not build_only and not script_path:
        raise StorageError("Native FEM simulation requires a script path")
    resolved_device = _resolve_windows_fem_device(device)
    profile = WINDOWS_NATIVE_FEM_STORAGE_PROFILES[resolved_device]
    _validate_windows_fem_profile(layout, resolved_device)
    launcher = validate_path(
        Path(layout["repo_root"]) / "scripts" / "windows" / "run_fullmag.ps1",
        layout["repo_root"],
        "native FEM launcher",
    )
    if not launcher.is_file():
        raise StorageError(f"Native FEM launcher is missing: {launcher}")

    resolved_script = None
    if script_path:
        script_candidate = Path(script_path)
        if not script_candidate.is_absolute():
            script_candidate = Path(layout["repo_root"]) / script_candidate
        candidate = absolute(str(script_candidate), "native FEM script")
        repo_root = Path(layout["repo_root"])
        if not inside(candidate, repo_root) or not candidate.is_file():
            raise StorageError(f"Native FEM script must be an existing file inside the checkout: {candidate}")
        resolved_script = candidate
    if output_dir:
        output_candidate = Path(output_dir)
        output_root = Path(layout["build_storage_root"])
        if not output_candidate.is_absolute():
            output_candidate = output_root / output_candidate
        resolved_output = validate_path(str(output_candidate), output_root, "native FEM output")
        if resolved_output == output_root:
            raise StorageError("Native FEM output must be a storage subdirectory")
    else:
        resolved_output = validate_path(
            Path(layout["runs_root"]) / "windows-fem" / uuid.uuid4().hex,
            layout["storage_root"],
            "native FEM output",
        )
    # Initialize the canonical storage tree before creating a run directory;
    # no output is allowed to appear before the managed marker and layout have
    # passed their final mutation-boundary checks.
    initialize(layout)
    resolved_output.mkdir(parents=True, exist_ok=True)
    if web_port == 0 and run_mode == "interactive":
        # Pick an ephemeral host port for the native UI handoff.  The launcher
        # receives the concrete port, so it never has to infer one from state.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            web_port = int(probe.getsockname()[1])

    command = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", str(launcher),
        "-BuildMode", build_mode, "-Frontend", frontend,
        "-BackendProfile", "release", "-Backend", "fem",
        "-Device", resolved_device, "-RunMode", run_mode,
        "-OutputDir", str(resolved_output), "-WebPort", str(web_port),
    ]
    if resolved_script is not None:
        command.extend(("-ScriptPath", str(resolved_script)))
    if build_only:
        command.append("-BuildOnly")
    if skip_local_changes:
        command.append("-SkipLocalChanges")
    if expected_build_id is not None:
        command.extend(("-ExpectedBuildId", expected_build_id))

    def run_phase(phase_command, phase_execution_mode, phase_attempt_id, phase_record, *, phase_build):
        return _run_managed_command(
            layout,
            phase_command,
            acquire_heavy_slot=phase_build,
            native_user_build=phase_build,
            native_fem_paths=True,
            fem_device=resolved_device,
            fem_requested_device=device,
            execution_mode=phase_execution_mode,
            native_manifest_relative="windows-fem-runtime/build-manifest.json",
            result_record=phase_record,
            attempt_id=phase_attempt_id,
        )

    active_execution_mode = "windows-fem-build" if build_only else "windows-fem"
    active_attempt_id = uuid.uuid4().hex
    active_attempt_started_at = now()
    active_record = {}
    result = None
    try:
        if build_mode == "true" and not build_only:
            build_command = list(command)
            build_command.append("-BuildOnly")
            build_record = {}
            active_execution_mode = "windows-fem-build"
            active_attempt_id = uuid.uuid4().hex
            active_attempt_started_at = now()
            active_record = build_record
            result = run_phase(
                build_command, active_execution_mode, active_attempt_id, build_record,
                phase_build=True,
            )
            if result != 0:
                return result

            runtime_attempt_id = uuid.uuid4().hex
            runtime_record = {}
            active_execution_mode = "windows-fem"
            active_attempt_id = runtime_attempt_id
            active_attempt_started_at = now()
            active_record = runtime_record
            manifest_identity = build_record.get("build_manifest_sha256")
            if not isinstance(manifest_identity, str) or not SHA256_RE.fullmatch(manifest_identity):
                raise StorageError("Native FEM build completed without a pinned output manifest")
            runtime_command = list(command)
            runtime_command[runtime_command.index("-BuildMode") + 1] = "false"
            runtime_command.extend(("-ExpectedBuildId", manifest_identity))
            result = run_phase(
                runtime_command, active_execution_mode, active_attempt_id, runtime_record,
                phase_build=False,
            )
        else:
            active_execution_mode = "windows-fem-build" if build_only else "windows-fem"
            result = run_phase(
                command, active_execution_mode, active_attempt_id, active_record,
                phase_build=build_only,
            )
        return result
    finally:
        primary_error = sys.exc_info()[1]
        status = {}

        def matches_active_attempt(candidate):
            return (
                isinstance(candidate, dict)
                and candidate.get("attempt_id") == active_attempt_id
                and candidate.get("worktree_id") == layout["worktree_id"]
                and candidate.get("profile") == profile
                and candidate.get("repo_root") == layout["repo_root"]
                and candidate.get("execution_mode") == active_execution_mode
                and candidate.get("state") in {"completed", "failed", "interrupted"}
            )

        if matches_active_attempt(active_record):
            status = active_record
        try:
            status_path = validate_path(
                Path(layout["build_root"]) / "build-status.json",
                layout["build_storage_root"],
                "native FEM build status",
            )
            if not status and status_path.is_file():
                try:
                    candidate = json.loads(status_path.read_text(encoding="utf-8"))
                    if matches_active_attempt(candidate):
                        status = candidate
                except (OSError, ValueError):
                    status = {}
        except (OSError, StorageError, ValueError):
            # Preserve the operation's original failure; the receipt still
            # records interrupted when the terminal build status is absent.
            status = {}
        receipt = {
            "schema": WINDOWS_NATIVE_FEM_RECEIPT_SCHEMA,
            "worktree_id": layout["worktree_id"],
            "profile": profile,
            "requested_device": device,
            "resolved_device": resolved_device,
            "frontend": frontend,
            "run_mode": run_mode,
            "build_mode": build_mode,
            "build_only": bool(build_only),
            "script": str(resolved_script) if resolved_script is not None else None,
            "output_dir": str(resolved_output),
            "execution_mode": active_execution_mode,
            "attempt_id": active_attempt_id,
            "state": status.get("state", "interrupted"),
            "exit_code": status.get("exit_code"),
            "build_manifest_sha256": status.get("build_manifest_sha256"),
            "started_at": status.get("started_at", active_attempt_started_at),
            "finished_at": status.get("finished_at", now()),
        }
        try:
            _publish_native_fem_receipt(layout, receipt)
        except BaseException:
            if primary_error is None:
                raise


def _windows_fem_workspace_request(layout, frontend, device, web_port):
    if not _is_native_windows():
        raise StorageError("Native Windows FEM browser workspace requires native Windows")
    if frontend not in ("static", "dev"):
        raise StorageError("Native FEM browser frontend must be static or dev")
    if device not in ("auto", "cpu", "gpu"):
        raise StorageError("Native FEM browser device must be auto, cpu or gpu")
    if type(web_port) is not int or not 0 <= web_port <= 65535:
        raise StorageError("Native FEM browser web port must be an integer from 0 to 65535")
    resolved_device = _resolve_windows_fem_device(device)
    profile = WINDOWS_NATIVE_FEM_STORAGE_PROFILES[resolved_device]
    _validate_windows_fem_profile(layout, resolved_device)
    launcher = validate_path(
        Path(layout["repo_root"]) / "scripts" / "windows" / "run_fullmag.ps1",
        layout["repo_root"],
        "native FEM browser launcher",
    )
    if not launcher.is_file():
        raise StorageError(f"Native FEM launcher is missing: {launcher}")
    return resolved_device, profile, launcher


def run_windows_fem_workspace(
    layout,
    frontend,
    device,
    web_port=0,
    build_mode="false",
    build_only=False,
    skip_local_changes=False,
    expected_build_id=None,
):
    """Build or run an empty native FEM workspace in the system browser.

    This operation intentionally uses the native FEM build lock and manifest
    admission without entering the FDM ``run_sealed_runtime`` lane.  The
    browser CLI owns its API and free-port selection; a zero web port is kept
    as an explicit request rather than being bound to another workspace.
    """
    if build_mode not in ("true", "false"):
        raise StorageError("Native FEM browser build mode must be true or false")
    if build_only and build_mode != "true":
        raise StorageError("Native FEM browser build-only requires build mode true")
    if expected_build_id is not None and not SHA256_RE.fullmatch(expected_build_id):
        raise StorageError("Native FEM browser expected build id must be a lowercase manifest SHA256")
    if expected_build_id is not None and build_mode != "false":
        raise StorageError("Native FEM browser expected build id is only valid for runtime")
    resolved_device, profile, launcher = _windows_fem_workspace_request(
        layout, frontend, device, web_port
    )
    command = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", str(launcher),
        "-BuildMode", build_mode, "-Frontend", frontend,
        "-BackendProfile", "release", "-Backend", "fem",
        "-Device", resolved_device, "-RunMode", "workspace",
        "-WebPort", str(web_port), "-Browser",
    ]
    if build_only:
        command.append("-BuildOnly")
    if skip_local_changes:
        command.append("-SkipLocalChanges")
    if expected_build_id is not None:
        command.extend(("-ExpectedBuildId", expected_build_id))

    def run_phase(phase_command, phase_execution_mode, phase_attempt_id, phase_record, *, phase_build):
        return _run_managed_command(
            layout,
            phase_command,
            acquire_heavy_slot=phase_build,
            native_user_build=phase_build,
            native_fem_paths=True,
            fem_browser_workspace=True,
            fem_device=resolved_device,
            fem_requested_device=device,
            fem_frontend=frontend,
            execution_mode=phase_execution_mode,
            native_manifest_relative="windows-fem-runtime/build-manifest.json",
            result_record=phase_record,
            attempt_id=phase_attempt_id,
        )

    active_execution_mode = "windows-fem-workspace-build" if build_only else "windows-fem-workspace"
    active_attempt_id = uuid.uuid4().hex
    active_attempt_started_at = now()
    active_record = {}
    result = None
    try:
        if build_mode == "true" and not build_only:
            build_command = list(command)
            build_command.append("-BuildOnly")
            build_record = {}
            active_execution_mode = "windows-fem-workspace-build"
            active_attempt_id = uuid.uuid4().hex
            active_attempt_started_at = now()
            active_record = build_record
            result = run_phase(
                build_command, active_execution_mode, active_attempt_id, build_record,
                phase_build=True,
            )
            if result != 0:
                return result
            manifest_identity = build_record.get("build_manifest_sha256")
            if not isinstance(manifest_identity, str) or not SHA256_RE.fullmatch(manifest_identity):
                raise StorageError("Native FEM browser build completed without a pinned output manifest")
            runtime_command = list(command)
            runtime_command[runtime_command.index("-BuildMode") + 1] = "false"
            runtime_command.extend(("-ExpectedBuildId", manifest_identity))
            runtime_record = {}
            active_execution_mode = "windows-fem-workspace"
            active_attempt_id = uuid.uuid4().hex
            active_attempt_started_at = now()
            active_record = runtime_record
            result = run_phase(
                runtime_command, active_execution_mode, active_attempt_id, runtime_record,
                phase_build=False,
            )
        else:
            result = run_phase(
                command, active_execution_mode, active_attempt_id, active_record,
                phase_build=build_only,
            )
        return result
    finally:
        primary_error = sys.exc_info()[1]
        status = {}

        def matches_active_attempt(candidate):
            return (
                isinstance(candidate, dict)
                and candidate.get("attempt_id") == active_attempt_id
                and candidate.get("worktree_id") == layout["worktree_id"]
                and candidate.get("profile") == profile
                and candidate.get("repo_root") == layout["repo_root"]
                and candidate.get("execution_mode") == active_execution_mode
                and candidate.get("state") in {"completed", "failed", "interrupted"}
            )

        if matches_active_attempt(active_record):
            status = active_record
        try:
            status_path = validate_path(
                Path(layout["build_root"]) / "build-status.json",
                layout["build_storage_root"],
                "native FEM browser build status",
            )
            if not status and status_path.is_file():
                try:
                    candidate = json.loads(status_path.read_text(encoding="utf-8"))
                    if matches_active_attempt(candidate):
                        status = candidate
                except (OSError, ValueError):
                    status = {}
        except (OSError, StorageError, ValueError):
            status = {}
        receipt = {
            "schema": WINDOWS_NATIVE_FEM_RECEIPT_SCHEMA,
            "worktree_id": layout["worktree_id"],
            "profile": profile,
            "requested_device": device,
            "resolved_device": resolved_device,
            "frontend": frontend,
            "ui_host": "browser",
            "workspace_mode": "empty",
            "browser_workspace": True,
            "run_mode": "workspace",
            "build_mode": build_mode,
            "build_only": bool(build_only),
            "script": None,
            "output_dir": None,
            "web_port": web_port,
            "execution_mode": active_execution_mode,
            "attempt_id": active_attempt_id,
            "state": status.get("state", "interrupted"),
            "exit_code": status.get("exit_code"),
            "build_manifest_sha256": status.get("build_manifest_sha256"),
            "started_at": status.get("started_at", active_attempt_started_at),
            "finished_at": status.get("finished_at", now()),
        }
        try:
            _publish_native_fem_receipt(layout, receipt)
        except BaseException:
            if primary_error is None:
                raise


def _windows_full_workspace_request(layout, frontend, web_port):
    if not _is_native_windows():
        raise StorageError("Full workspace requires native Windows")
    if layout.get("profile") != WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE:
        raise StorageError("Full workspace requires the windows-native-fem-gpu storage profile")
    if frontend != "static":
        raise StorageError("Full workspace is only available with the pinned static frontend")
    if type(web_port) is not int or not 0 <= web_port <= 65535:
        raise StorageError("Full workspace web port must be an integer from 0 to 65535")
    launcher = validate_path(
        Path(layout["repo_root"]) / "scripts" / "windows" / "run_fullmag.ps1",
        layout["repo_root"],
        "full workspace launcher",
    )
    if not launcher.is_file():
        raise StorageError(f"Full workspace launcher is missing: {launcher}")
    return launcher


def run_windows_full_workspace(
    layout,
    frontend="static",
    web_port=0,
    build_mode="false",
    build_only=False,
    skip_local_changes=False,
    expected_build_id=None,
):
    """Build or run the one all-realizations native workspace route.

    The native producer remains physically FEM GPU backed, while its admitted
    aggregate manifest exposes the four requested capabilities.  Build and
    runtime are separate managed phases so a runtime can only consume the
    immutable aggregate receipt produced by the build phase.
    """
    if build_mode not in ("true", "false"):
        raise StorageError("Full workspace build mode must be true or false")
    if build_only and build_mode != "true":
        raise StorageError("Full workspace build-only requires build mode true")
    if expected_build_id is not None and not SHA256_RE.fullmatch(expected_build_id):
        raise StorageError("Full workspace expected build id must be a lowercase manifest SHA256")
    if expected_build_id is not None and build_mode != "false":
        raise StorageError("Full workspace expected build id is only valid for runtime")
    launcher = _windows_full_workspace_request(layout, frontend, web_port)
    command = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", str(launcher),
        "-BuildMode", build_mode, "-Frontend", frontend,
        "-BackendProfile", "release", "-Backend", "auto", "-Device", "auto",
        "-RunMode", "workspace", "-WebPort", str(web_port), "-Browser", "-AllBackends",
    ]
    if build_only:
        command.append("-BuildOnly")
    if skip_local_changes:
        command.append("-SkipLocalChanges")
    if build_mode == "false" and expected_build_id is None:
        # The recipe may omit the digest for convenience, but the storage
        # boundary must choose it under its build lock.  The child still gets
        # an explicit ExpectedBuildId, so the PowerShell/runtime handoff never
        # relies on an unpinned mutable alias.
        initialize(layout)
        with build_lock(layout):
            manifest_path = _full_workspace_manifest_path(layout)
            if not manifest_path.is_file():
                raise StorageError("Full workspace runtime has no completed build manifest")
            expected_build_id = _sha256_file(manifest_path)
            validate_full_workspace_handoff(layout, expected_build_id)
    if expected_build_id is not None:
        command.extend(("-ExpectedBuildId", expected_build_id))

    def run_phase(phase_command, phase_execution_mode, phase_attempt_id, phase_record, *, phase_build, origin_attempt):
        return _run_managed_command(
            layout,
            phase_command,
            acquire_heavy_slot=phase_build,
            native_user_build=phase_build,
            native_full_workspace_paths=True,
            execution_mode=phase_execution_mode,
            native_manifest_relative="windows-full-runtime/build-manifest.json",
            result_record=phase_record,
            attempt_id=phase_attempt_id,
            full_origin_attempt_id=origin_attempt,
        )

    if build_mode == "false" and expected_build_id is not None:
        admitted_manifest = validate_full_workspace_handoff(layout, expected_build_id)
        origin_attempt = admitted_manifest["attempt_id"]
    else:
        origin_attempt = None

    if build_mode == "true":
        build_command = list(command)
        if "-BuildOnly" not in build_command:
            build_command.append("-BuildOnly")
        build_attempt = uuid.uuid4().hex
        build_record = {}
        result = run_phase(
            build_command,
            "windows-full-workspace-build",
            build_attempt,
            build_record,
            phase_build=True,
            origin_attempt=build_attempt,
        )
        if result != 0 or build_record.get("state") != "completed":
            return result
        manifest_identity = build_record.get("build_manifest_sha256")
        if not isinstance(manifest_identity, str) or not SHA256_RE.fullmatch(manifest_identity):
            raise StorageError("Full workspace build completed without a pinned output manifest")
        admitted_manifest = validate_full_workspace_handoff(layout, manifest_identity)
        origin_attempt = admitted_manifest["attempt_id"]
        if build_only:
            return result
        command = list(command)
        command[command.index("-BuildMode") + 1] = "false"
        command.extend(("-ExpectedBuildId", manifest_identity))

    runtime_attempt = uuid.uuid4().hex
    runtime_record = {}
    return run_phase(
        command,
        "windows-full-workspace",
        runtime_attempt,
        runtime_record,
        phase_build=False,
        origin_attempt=origin_attempt,
    )


def run_windows_full_workspace_build(layout, frontend="static", web_port=0, skip_local_changes=False):
    return run_windows_full_workspace(
        layout,
        frontend=frontend,
        web_port=web_port,
        build_mode="true",
        build_only=True,
        skip_local_changes=skip_local_changes,
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
    parser.add_argument("action", choices=("resolve", "validate", "run", "run-windows-workspace", "run-windows-workspace-build", "run-windows-fem", "run-windows-fem-workspace", "run-windows-fem-workspace-build", "run-windows-full-workspace", "run-windows-full-workspace-build", "run-windows-installer-source", "register", "finish", "inventory", "prepare-links", "assert-lock"))
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
    parser.add_argument("--fem-frontend", choices=("static", "dev"))
    parser.add_argument("--fem-device", choices=("auto", "cpu", "gpu"))
    parser.add_argument("--fem-run-mode", choices=("interactive", "headless", "workspace"))
    parser.add_argument("--fem-script")
    parser.add_argument("--fem-output-dir")
    parser.add_argument("--fem-web-port", type=int, default=0)
    parser.add_argument("--fem-build-mode", choices=("true", "false"), default="false")
    parser.add_argument("--fem-build-only", action="store_true")
    parser.add_argument("--fem-skip-local-changes", action="store_true")
    parser.add_argument("--fem-expected-build-id")
    parser.add_argument("--full-frontend", choices=("static",))
    parser.add_argument("--full-web-port", type=int, default=0)
    parser.add_argument("--full-build-mode", choices=("true", "false"), default="false")
    parser.add_argument("--full-build-only", action="store_true")
    parser.add_argument("--full-skip-local-changes", action="store_true")
    parser.add_argument("--full-expected-build-id")
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
        selected_fem_device = None
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
        elif args.action in ("run-windows-fem", "run-windows-fem-workspace", "run-windows-fem-workspace-build"):
            if args.fem_frontend is None or args.fem_device is None:
                raise StorageError(f"{args.action} requires --fem-frontend and --fem-device")
            if args.action == "run-windows-fem" and args.fem_run_mode is None:
                raise StorageError("run-windows-fem requires --fem-run-mode")
            if args.action != "run-windows-fem" and args.fem_run_mode not in (None, "workspace"):
                raise StorageError(f"{args.action} requires workspace run mode")
            selected_fem_device = _resolve_windows_fem_device(args.fem_device)
            selected_storage_profile = WINDOWS_NATIVE_FEM_STORAGE_PROFILES[selected_fem_device]
        elif args.action in ("run-windows-full-workspace", "run-windows-full-workspace-build"):
            if args.full_frontend is None:
                raise StorageError(f"{args.action} requires --full-frontend static")
            if args.action == "run-windows-full-workspace-build":
                if args.full_build_mode != "true":
                    raise StorageError("run-windows-full-workspace-build requires --full-build-mode true")
                if args.full_build_only is False:
                    args.full_build_only = True
            elif args.full_build_only:
                raise StorageError("Full workspace build-only requires the dedicated workspace-build action")
            selected_storage_profile = WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE
        if args.action == "run-windows-installer-source":
            selected_storage_profile = WINDOWS_INSTALLER_SOURCE_PROFILE
        if selected_storage_profile:
            if args.profile and args.profile != selected_storage_profile:
                expected_kind = (
                    "native FEM device" if args.action == "run-windows-fem" else
                    "native FEM browser workspace device" if args.action in ("run-windows-fem-workspace", "run-windows-fem-workspace-build") else
                    "full workspace" if args.action in ("run-windows-full-workspace", "run-windows-full-workspace-build") else
                    "Windows installer producer" if args.action == "run-windows-installer-source" else
                    "Windows workspace compiler profile"
                )
                raise StorageError(f"Storage profile does not match the selected {expected_kind}: {selected_storage_profile}")
            layout = resolve_layout(args.repo_root, selected_storage_profile)
        else:
            layout = resolve_layout(args.repo_root, args.profile)
        if args.action == "assert-lock":
            if not os.environ.get("FULLMAG_STORAGE_LOCK_TOKEN") or os.environ.get("FULLMAG_STORAGE_LOCK_KEY") != layout["worktree_id"]:
                raise StorageError("No inherited managed lock; enter through the storage runner")
            with build_lock(layout):
                print(json.dumps({"locked": True, "worktree_id": layout["worktree_id"]}))
            return 0
        if args.action == "run-windows-installer-source":
            if command:
                raise StorageError("run-windows-installer-source does not accept an arbitrary command")
            return run_windows_installer_source(layout)
        if args.action == "run":
            return run(layout, command)
        if args.action == "run-windows-fem":
            if command:
                raise StorageError("run-windows-fem does not accept an arbitrary command")
            return run_windows_fem(
                layout,
                args.fem_frontend,
                args.fem_device,
                args.fem_run_mode,
                args.fem_script,
                args.fem_output_dir,
                args.fem_web_port,
                args.fem_build_mode,
                args.fem_build_only,
                args.fem_skip_local_changes,
                args.fem_expected_build_id,
            )
        if args.action in ("run-windows-fem-workspace", "run-windows-fem-workspace-build"):
            if command:
                raise StorageError(f"{args.action} does not accept an arbitrary command")
            if args.fem_frontend is None or args.fem_device is None:
                raise StorageError(f"{args.action} requires --fem-frontend and --fem-device")
            if args.fem_build_only and args.action != "run-windows-fem-workspace-build":
                raise StorageError("FEM browser build-only requires the dedicated workspace-build action")
            build_only = args.action == "run-windows-fem-workspace-build"
            if build_only and args.fem_build_mode != "true":
                raise StorageError("run-windows-fem-workspace-build requires --fem-build-mode true")
            if args.fem_expected_build_id is not None and args.action != "run-windows-fem-workspace":
                raise StorageError("FEM browser expected build id is only valid for runtime")
            return run_windows_fem_workspace(
                layout,
                args.fem_frontend,
                args.fem_device,
                args.fem_web_port,
                args.fem_build_mode,
                build_only,
                args.fem_skip_local_changes,
                args.fem_expected_build_id,
            )
        if args.action in ("run-windows-full-workspace", "run-windows-full-workspace-build"):
            if command:
                raise StorageError(f"{args.action} does not accept an arbitrary command")
            if args.full_frontend is None:
                raise StorageError(f"{args.action} requires --full-frontend static")
            if args.action == "run-windows-full-workspace-build":
                if args.full_expected_build_id is not None:
                    raise StorageError("Full workspace build-only does not accept ExpectedBuildId")
                return run_windows_full_workspace_build(
                    layout,
                    args.full_frontend,
                    args.full_web_port,
                    args.full_skip_local_changes,
                )
            if args.full_build_only:
                raise StorageError("Full workspace build-only requires the dedicated workspace-build action")
            return run_windows_full_workspace(
                layout,
                args.full_frontend,
                args.full_web_port,
                args.full_build_mode,
                False,
                args.full_skip_local_changes,
                args.full_expected_build_id,
            )
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
