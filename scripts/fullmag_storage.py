#!/usr/bin/env python3
"""Project-owned storage paths and build ownership; never deletes user data.

This is a build guard, not an OS sandbox. Use host permissions to restrict tools
that do not use Fullmag's entrypoints. Resolve is read-only unless --create is set.
"""

from __future__ import annotations

import argparse
import ast
from contextlib import contextmanager
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
import uuid


SCHEMA = "fullmag_storage_v1"
PATH_OVERRIDES = {
    "FULLMAG_WINDOWS_BUILD_ROOT": "build_root",
    "FULLMAG_WINDOWS_CACHE_ROOT": "cache_root",
    "FULLMAG_WINDOWS_TEMP_ROOT": "temp_root",
    "FULLMAG_BUILD_ROOT": "build_root",
    "FULLMAG_CACHE_ROOT": "cache_root",
    "FULLMAG_TEMP_ROOT": "temp_root",
    "FULLMAG_WINDOWS_TARGET_DIR": "build_root",
    "CARGO_TARGET_DIR": "build_root",
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
    "FULLMAG_PROJECT_STORAGE_ROOT", "FULLMAG_STORAGE_PROFILE",
    "FULLMAG_STORAGE_LOCK_TOKEN", "FULLMAG_STORAGE_LOCK_KEY",
    "FULLMAG_BUILD_STORAGE_ROOT", "FULLMAG_STORAGE_USE_MANAGED_EXT4",
    "FULLMAG_NATIVE_STORAGE_PROFILE", "FULLMAG_NATIVE_BUILD_IMAGE",
    "FULLMAG_NATIVE_MOUNT_VIEW", "FULLMAG_MANAGED_NATIVE_ROOT",
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


def atomic_json(path, data):
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        os.replace(temporary, path)
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
def file_lock(lock_path, key, blocking=False):
    with lock_path.open("a+b") as stream:
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except OSError as error:
            raise StorageError(f"Storage is busy: {key}. Reuse the running task or wait; do not allocate a random target.") from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


@contextmanager
def build_lock(layout):
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
            yield
            return
        raise StorageError("Inherited storage lock is stale; start a fresh managed command")
    with file_lock(lock_path, key):
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


@contextmanager
def managed_heavy_lock(layout):
    """Share the local heavy slot with snapshot workers, including recovery.

Nested managed commands are validated by build_lock below. An orphaned
container keeps its durable queue lease even after the host file lock closes.
"""
    if layout['profile'].startswith('windows-') and (Path(layout['storage_root']) / 'index' / 'local-runner-container.json').exists():
        raise StorageError('Container runner owns heavy builds on this host; submit a snapshot through just runner-build')
    if not layout['profile'].startswith('windows-') or (
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


def run(layout, command):
    if not command:
        raise StorageError("A command is required after --")
    initialize(layout)
    with managed_heavy_lock(layout), build_lock(layout):
        # `prepare-links` may have run in a separate shell and lock scope.  A
        # different lane can therefore have rebound the shared target link in
        # between; never execute a command against that stale profile.
        validate_prepared_links_for_run(layout)
        record = validate_path(Path(layout["build_root"]) / "build-status.json", layout["build_storage_root"], "build status")
        validate_existing_build_status(record, layout)
        state = {"schema": SCHEMA, "worktree_id": layout["worktree_id"], "profile": layout["profile"],
                 "repo_root": layout["repo_root"], "head": git(layout["repo_root"], "rev-parse", "HEAD"),
                 "source_dirty": bool(git(layout["repo_root"], "status", "--porcelain", "--untracked-files=normal")),
                 "pid": os.getpid(), "host": socket.gethostname(), "started_at": now(),
                 "state": "running", "executable": Path(command[0]).name,
                 "build_root": layout["build_root"], "frontend_root": layout["frontend_root"],
                 "runtime_root": layout["runtime_root"], "qualification": "not_assessed"}
        atomic_json(record, state)
        try:
            result = subprocess.run(command, cwd=layout["repo_root"], env={**os.environ, **layout["env"]})
            state.update(state="completed" if result.returncode == 0 else "failed", exit_code=result.returncode)
            return result.returncode
        except BaseException:
            state.update(state="interrupted")
            raise
        finally:
            state["finished_at"] = now()
            atomic_json(record, state)


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
        if record.get("schema") == SCHEMA and record.get("worktree_id"):
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
    parser.add_argument("action", choices=("resolve", "validate", "run", "register", "finish", "inventory", "prepare-links", "assert-lock"))
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--profile")
    parser.add_argument("--format", choices=("json", "sh"), default="json")
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--path")
    parser.add_argument("--frontend", action="store_true")
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
        layout = resolve_layout(args.repo_root, args.profile)
        if args.action == "assert-lock":
            if not os.environ.get("FULLMAG_STORAGE_LOCK_TOKEN") or os.environ.get("FULLMAG_STORAGE_LOCK_KEY") != layout["worktree_id"]:
                raise StorageError("No inherited managed lock; enter through the storage runner")
            with build_lock(layout):
                print(json.dumps({"locked": True, "worktree_id": layout["worktree_id"]}))
            return 0
        if args.action == "run":
            return run(layout, command)
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
