"""Seed isolated Linux frontend metadata and bind live host source folders.

The selected checkout's root package manifest and its ``patches/**/*.patch``
files are immutable dependency inputs.  The application source directories
remain live readonly mounts.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import uuid

import fullmag_storage as storage
from docker_dev_host import local_volume, require_host


def read_owned_regular(path, maximum=1024 * 1024):
    """Use the host's no-follow reader without issuing Windows proof on Linux."""
    if os.name == "nt":
        from windows_folder_host import read_owned_regular as reader
    else:
        from linux_native_host import read_owned_regular as reader
    return reader(path, maximum=maximum)

DIRECTORIES = ("app", "src", "public", "scripts")
NEXT_CONFIG_RELATIVE = Path("apps/control-room/next.config.ts")
WORKSPACE = "/state/development/workspace"
FRONTEND = "/state/development/cache"
CONFIG_TARGET = "/run/fullmag/development-inputs.json"
NEXT_GENERATED_DIST_DIR = ".next-control-room-8080"
NEXT_GENERATED_RELATIVES = frozenset({
    "apps/control-room/next-env.d.ts",
    "apps/control-room/tsconfig.json",
})
HOST_CACHE_METADATA_KEYS = frozenset({
    "worktree_id", "dependency_seed_files", "dependency_seed_sha256",
    "toolpins", "toolpins_sha256",
})
FRONTEND_VOLUME_UID = 65532
FRONTEND_VOLUME_GID = 65532


def _named_volume_permission_error(path, error):
    """Return an actionable error when a named-volume mount is not writable."""

    return ValueError(
        "Frontend named-volume path is not writable by "
        f"UID {FRONTEND_VOLUME_UID}:GID {FRONTEND_VOLUME_GID}: {path}. "
        "Provision the named volume with that ownership before starting the "
        "frontend; do not redirect this data to host storage."
    )


def guest_manifest(inputs):
    """Keep the pinned v1 guest contract independent of host cache metadata.

    The complete host document is retained beside the guest manifest and
    remains the source of cache preparation and mount attestation.
    """
    return {name: value for name, value in inputs.items() if name not in HOST_CACHE_METADATA_KEYS}


def main_checkout(repo):
    records = storage.worktree_records(repo)
    if not records:
        raise ValueError("Git did not identify the main checkout")
    return Path(records[0]["worktree"]).resolve()


def select_checkout(repo, source_root=None):
    """Choose one Git-registered checkout of this project, never an inferred path."""
    source_root = source_root or os.environ.get("FULLMAG_SOURCE_ROOT")
    selected = (storage.absolute(source_root, "development source checkout").resolve(strict=True)
                if source_root else main_checkout(repo))
    known = {Path(record["worktree"]).resolve() for record in storage.worktree_records(repo)}
    if selected not in known:
        raise ValueError("Development sources must be a registered checkout of this project")
    if os.name == "nt":
        local_volume(selected)
    return selected


def _read_json_file(path, label):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label} is not a regular file: {path}")
    try:
        value = json.loads(path.read_bytes())
    except (OSError, UnicodeError, ValueError) as error:
        raise ValueError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain an object")
    return value


def _pnpm_patch_relatives(source):
    """Compatibility wrapper for the canonical no-follow patch inventory."""
    from windows.stage_workspace_frontend import patch_file_relatives

    return patch_file_relatives(Path(source))


def _next_generated_seed_variants(relative, source):
    """Return the exact Next-generated variants accepted after first startup."""
    variants = {source}
    if relative not in NEXT_GENERATED_RELATIVES:
        return variants
    newline = b"\r\n" if b"\r\n" in source else b"\n"
    if relative == "apps/control-room/next-env.d.ts":
        marker = b'import "./.next/types/routes.d.ts";'
        replacement = (
            b'import "./' + NEXT_GENERATED_DIST_DIR.encode() + b'/dev/types/routes.d.ts";'
            + newline
            + b'import "./' + NEXT_GENERATED_DIST_DIR.encode() + b'/dev/types/root-params.d.ts";'
        )
        if source.count(marker) == 1:
            variants.add(source.replace(marker, replacement, 1))
        return variants

    # Next rewrites tsconfig through its JSON writer, so its generated form
    # uses LF even when the Windows checkout seed uses CRLF.
    normalized = source.replace(b"\r\n", b"\n")
    marker = b'    ".next-control-room-3100/dev/types/**/*.ts"\n  ],'
    replacement = (
        b'    ".next-control-room-3100/dev/types/**/*.ts",\n'
        + b'    "' + NEXT_GENERATED_DIST_DIR.encode() + b'/types/**/*.ts",\n'
        + b'    "' + NEXT_GENERATED_DIST_DIR.encode() + b'/dev/types/**/*.ts"\n  ],'
    )
    if normalized.count(marker) == 1:
        variants.add(normalized.replace(marker, replacement, 1))
    return variants


def _describe_regular(path, *, maximum):
    """Read one dependency input without creating or replacing anything."""

    path = Path(path)
    for ancestor in (path, *path.parents):
        if storage.is_link(ancestor):
            raise ValueError(f"Frontend dependency input traverses a reparse point: {path}")
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ValueError(f"Cannot inspect frontend dependency input: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"Frontend dependency input is not a regular file: {path}")
    if metadata.st_size > maximum:
        raise ValueError(f"Frontend dependency input is too large: {path}")
    try:
        data = path.read_bytes()
    except OSError as error:
        raise ValueError(f"Cannot read frontend dependency input: {path}") from error
    if len(data) != metadata.st_size:
        raise ValueError(f"Frontend dependency input changed while being read: {path}")
    return data


def describe(source, port):
    """Describe frontend dependency identity without touching build storage.

    This host-side operation is intentionally read-only.  It computes the
    dependency seed used by the Compose named-volume cache, while workspace
    metadata and the live source mounts are created later by ``seed_guest`` in
    the frontend container.
    """

    raw_source = Path(source)
    if not raw_source.is_absolute() or storage.is_link(raw_source):
        raise ValueError("Frontend source checkout must be an absolute real directory")
    source = raw_source.resolve(strict=True)
    if not source.is_dir() or storage.is_link(source):
        raise ValueError("Frontend source checkout must be a real directory")
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("port must be an integer in 1024..65535")

    initial_commit = storage.git(source, "rev-parse", "HEAD")
    if not re.fullmatch(r"[a-f0-9]{40}", initial_commit):
        raise ValueError("Frontend source checkout has no full commit identity")
    app = source / "apps" / "control-room"
    directories = []
    for name in DIRECTORIES:
        path = app / name
        if not path.is_dir() or storage.is_link(path):
            raise ValueError(f"Missing live frontend source directory: {path}")
        directories.append(
            {
                "name": name,
                "source": str(source / "apps" / "control-room" / name),
                "target": WORKSPACE + "/apps/control-room/" + name,
            }
        )

    package_relative = Path("package.json")
    package_data = _describe_regular(
        source / package_relative, maximum=16 * 1024 * 1024
    )
    patch_relatives = _pnpm_patch_relatives(source)
    relative_files = {
        Path(name) for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")
    }
    relative_files.update(patch_relatives)
    dependency_files = set(relative_files)
    # Next reads this file before the dev server starts.  It is therefore a
    # cache identity input even though it is outside the live HMR directories.
    relative_files.add(NEXT_CONFIG_RELATIVE)
    dependency_files.add(NEXT_CONFIG_RELATIVE)
    from windows.stage_workspace_frontend import (
        _direct_app_package_manifests,
        _parse_lock_importers,
    )

    importers = _parse_lock_importers(source / "pnpm-lock.yaml")
    for path in _direct_app_package_manifests(source, importers):
        relative = path.relative_to(source)
        relative_files.add(relative)
        dependency_files.add(relative)
    for path in app.iterdir():
        if path.suffix in {".ts", ".tsx", ".json", ".mjs", ".css"} and path.is_file():
            relative_files.add(path.relative_to(source))

    files = []
    dependency_entries = {}
    for relative in sorted(relative_files, key=str):
        data = (
            package_data
            if relative == package_relative
            else _describe_regular(source / relative, maximum=16 * 1024 * 1024)
        )
        digest = hashlib.sha256(data).hexdigest()
        relative_name = relative.as_posix()
        files.append({"relative": relative_name, "sha256": digest})
        if relative in dependency_files:
            dependency_entries[relative_name] = digest

    commit = storage.git(source, "rev-parse", "HEAD")
    if commit != initial_commit:
        raise ValueError("Frontend configuration changed during metadata capture")
    for file in files:
        current = _describe_regular(
            source / file["relative"], maximum=16 * 1024 * 1024
        )
        if hashlib.sha256(current).hexdigest() != file["sha256"]:
            raise ValueError(
                "Frontend configuration changed during metadata capture: "
                + file["relative"]
            )
    if _pnpm_patch_relatives(source) != patch_relatives:
        raise ValueError("Pnpm patch inventory changed during metadata capture")
    from docker_frontend_cache import default_toolpins, dependency_seed_digest, toolpins_digest

    toolpins = default_toolpins()
    worktree_id = storage.identifier(source)
    dependency_seed_sha256 = dependency_seed_digest(dependency_entries)
    return {
        "schema": "fullmag.docker-development-inputs.v1",
        "source_root": str(source),
        "source_commit": commit,
        "source_selection": ("live_windows_selected_checkout" if os.name == "nt"
                             else "live_linux_selected_checkout"),
        "host_port": port,
        "worktree_id": worktree_id,
        "dependency_seed_files": sorted(dependency_entries),
        "dependency_seed_sha256": dependency_seed_sha256,
        "toolpins": toolpins,
        "toolpins_sha256": toolpins_digest(toolpins),
        "workspace_root": WORKSPACE,
        "frontend_root": FRONTEND,
        "live_directories": directories,
        "files": files,
        "configuration_changes": "describe_only",
        "backend_build": "explicit_request_only",
    }


def _validate_reused_workspace(destination, inputs, old_inputs, *, generated_sources=None):
    """Prove that the persistent Linux metadata is reusable without rewriting it."""
    if not destination.is_dir() or destination.is_symlink():
        raise ValueError("Persistent frontend workspace is missing or a reparse point")
    if old_inputs.get("schema") != "fullmag.docker-development-inputs.v1":
        raise ValueError("Persistent frontend inputs have an unsupported schema")
    for field in ("source_root", "worktree_id", "host_port", "dependency_seed_sha256",
                  "toolpins_sha256", "workspace_root", "frontend_root", "live_directories"):
        if old_inputs.get(field) != inputs.get(field):
            raise ValueError("Persistent frontend dependency identity changed; use a fresh run")
    old_file_list = old_inputs.get("files")
    current_file_list = inputs.get("files")
    if not isinstance(old_file_list, list) or not isinstance(current_file_list, list):
        raise ValueError("Persistent frontend seed file inventory is malformed")
    old_files = {
        str(item.get("relative")): item.get("sha256")
        for item in old_file_list
        if isinstance(item, dict)
    }
    current_files = {
        str(item.get("relative")): item.get("sha256")
        for item in current_file_list
        if isinstance(item, dict)
    }
    if (len(old_files) != len(old_file_list)
            or len(current_files) != len(current_file_list)
            or old_files != current_files):
        raise ValueError("Persistent frontend seed file inventory changed; use a fresh run")
    if (not isinstance(old_inputs.get("dependency_seed_files"), list)
            or not isinstance(inputs.get("dependency_seed_files"), list)):
        raise ValueError("Persistent frontend dependency file set is malformed")
    dependency_files = set(inputs["dependency_seed_files"])
    old_dependency_files = {
        str(value) for value in old_inputs.get("dependency_seed_files", [])
        if isinstance(value, str)
    }
    if old_dependency_files != dependency_files:
        raise ValueError("Persistent frontend dependency file set changed; use a fresh run")
    for name in DIRECTORIES:
        directory = storage.validate_path(
            destination / "apps" / "control-room" / name,
            destination,
            "persistent frontend live directory",
        )
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError("Persistent frontend live directory is missing or a reparse point")
    for relative, expected in old_files.items():
        if not re.fullmatch(r"[0-9a-f]{64}", str(expected or "")):
            raise ValueError("Persistent frontend seed metadata is incomplete")
        target = storage.validate_path(destination / relative, destination,
                                       "persistent frontend metadata")
        data = read_owned_regular(target, maximum=16 * 1024 * 1024)
        if hashlib.sha256(data).hexdigest() == expected:
            continue
        source = (generated_sources or {}).get(relative)
        if source is not None and data in _next_generated_seed_variants(relative, source):
            continue
        raise ValueError(f"Persistent frontend seed metadata was changed: {relative}")


def seed(source, state, port, *, reuse_from=None, write_file=None):
    require_host()
    # Check lexical input before resolving so a checkout alias cannot hide a link.
    source = storage.absolute(source, "live source checkout").resolve(strict=True)
    source_volume = local_volume(source)
    initial_commit = storage.git(source, "rev-parse", "HEAD")
    app = source / "apps/control-room"
    directories = []
    for name in DIRECTORIES:
        path = app / name
        if not path.is_dir():
            raise ValueError(f"Missing live frontend source directory: {path}")
        local_volume(path)
        directories.append({"name": name, "source": str(path),
                            "target": WORKSPACE + "/apps/control-room/" + name})
    package_relative = Path("package.json")
    package_data = read_owned_regular(source / package_relative, maximum=16 * 1024 * 1024)
    patch_relatives = _pnpm_patch_relatives(source)
    relative_files = {
        Path(name) for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")
    }
    relative_files.update(patch_relatives)
    dependency_files = set(relative_files)
    relative_files.add(NEXT_CONFIG_RELATIVE)
    dependency_files.add(NEXT_CONFIG_RELATIVE)
    # Pnpm patch files are frozen dependency inputs, while app dirs remain live
    # readonly mounts.  The complete patches/ tree is captured so pnpm's
    # authoritative registration format stays responsible for declaration and
    # lockfile consistency.
    # The lockfile can contain other workspace importers. Copy their manifests,
    # while only Control Room sources become live container inputs.
    from windows.stage_workspace_frontend import _parse_lock_importers, _direct_app_package_manifests
    importers = _parse_lock_importers(source / "pnpm-lock.yaml")
    for path in _direct_app_package_manifests(source, importers):
        relative = path.relative_to(source)
        relative_files.add(relative)
        dependency_files.add(relative)
    for path in app.iterdir():
        # Generated cache junctions may be broken from another host/runtime.
        # Do not follow them merely to enumerate regular app configuration.
        if path.suffix in {".ts", ".tsx", ".json", ".mjs", ".css"} and path.is_file():
            relative_files.add(path.relative_to(source))
    files = []
    source_files = {}
    dependency_entries = {}
    destination = storage.validate_path(state / "development/workspace", state,
                                        "isolated Docker frontend workspace")
    if write_file is not None and reuse_from is not None:
        raise ValueError("Volume seeding and host workspace reuse are separate contracts")
    if reuse_from is not None:
        if not destination.is_dir() or destination.is_symlink():
            raise ValueError("Persistent frontend workspace is missing or a reparse point")
    elif write_file is None:
        destination.mkdir(parents=True, exist_ok=False)
    for relative in sorted(relative_files, key=str):
        try:
            data = (package_data if relative == package_relative else
                    read_owned_regular(source / relative, maximum=16 * 1024 * 1024))
        except OSError as error:
            if relative in patch_relatives:
                raise ValueError(
                    f"Pnpm patch file is missing or unavailable: {relative}"
                ) from error
            raise
        target = storage.validate_path(destination / relative, destination, "frontend metadata")
        if write_file is not None:
            write_file(relative.as_posix(), data)
        elif reuse_from is None:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        digest = hashlib.sha256(data).hexdigest()
        source_files[relative.as_posix()] = data
        files.append({"relative": relative.as_posix(), "sha256": digest})
        if relative in dependency_files:
            dependency_entries[relative.as_posix()] = digest
    commit = storage.git(source, "rev-parse", "HEAD")
    if commit != initial_commit:
        raise ValueError("Main checkout HEAD changed during frontend metadata capture")
    for file in files:
        current = read_owned_regular(source / file["relative"], maximum=16 * 1024 * 1024)
        if hashlib.sha256(current).hexdigest() != file["sha256"]:
            raise ValueError("Frontend configuration changed during metadata capture: " + file["relative"])
    if _pnpm_patch_relatives(source) != patch_relatives:
        raise ValueError("Pnpm patch inventory changed during metadata capture")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Live source checkout has no full commit identity")
    from docker_frontend_cache import default_toolpins, dependency_seed_digest, toolpins_digest
    toolpins = default_toolpins()
    dependency_seed_sha256 = dependency_seed_digest(dependency_entries)
    if reuse_from is not None:
        # Re-check against the fully computed identity after tool pins and the
        # dependency digest are known.  The first validation above intentionally
        # checks only immutable workspace metadata and the selected checkout.
        current_identity = {
            "source_root": str(source),
            "worktree_id": storage.identifier(source),
            "host_port": port,
            "dependency_seed_sha256": dependency_seed_sha256,
            "toolpins_sha256": toolpins_digest(toolpins),
            "dependency_seed_files": sorted(dependency_entries),
            "workspace_root": WORKSPACE,
            "frontend_root": FRONTEND,
            "live_directories": directories,
            "files": files,
        }
        old_inputs = _read_json_file(reuse_from, "persistent frontend inputs")
        _validate_reused_workspace(
            destination,
            current_identity,
            old_inputs,
            generated_sources=source_files,
        )
        # frontend_dev freezes this exact host manifest, including source
        # commit and manifest digest.  Keep it byte-for-byte unchanged while
        # recording the current checkout identity in the outer run receipt.
        return old_inputs
    return {"schema": "fullmag.docker-development-inputs.v1", "source_root": str(source),
            "source_commit": commit, "source_selection": ("live_windows_selected_checkout" if os.name == "nt"
                                                          else "live_linux_selected_checkout"),
            "source_volume": source_volume, "host_port": port,
            "worktree_id": storage.identifier(source),
            "dependency_seed_files": sorted(dependency_entries),
            "dependency_seed_sha256": dependency_seed_sha256,
            "toolpins": toolpins,
            "toolpins_sha256": toolpins_digest(toolpins),
            "workspace_root": WORKSPACE, "frontend_root": FRONTEND,
            "live_directories": directories, "files": files,
            "configuration_changes": ("reuse_existing_workspace"
                                       if reuse_from is not None else "prepare_new_workspace"),
            "backend_build": "explicit_request_only"}



def _validate_guest_workspace(workspace, expected_files, *, maximum=16 * 1024 * 1024):
    """Validate a possibly interrupted guest seed without deleting its state.

    A seed may be interrupted after the workspace directory is created but
    before its control-volume manifest is published.  Existing files are
    admitted only when they are the exact bytes expected from the current
    readonly checkout; unknown files, links and mismatches remain fail-closed.
    The four application directories are live readonly bind-mount targets,
    so their contents are validated by the mount attestation and must not be
    mistaken for persistent seed metadata here.
    """
    workspace = Path(workspace)
    if workspace.is_symlink() or not workspace.is_dir():
        raise ValueError("Persistent frontend workspace is missing or a reparse point")
    expected = {Path(relative): (bytes(data) if data is not None else None)
                for relative, data in expected_files.items()}
    allowed_files = {relative.as_posix() for relative in expected}
    allowed_directories = set()
    for relative in expected:
        for index in range(1, len(relative.parts)):
            allowed_directories.add(Path(*relative.parts[:index]).as_posix())
    for name in DIRECTORIES:
        allowed_directories.add(Path("apps", "control-room", name).as_posix())
        allowed_directories.add(Path("apps", "control-room").as_posix())
        allowed_directories.add(Path("apps").as_posix())

    live_mount_targets = {
        Path("apps") / "control-room" / name for name in DIRECTORIES
    }
    for root, directories, filenames in os.walk(workspace, topdown=True, followlinks=False):
        root_path = Path(root)
        for name in list(directories):
            candidate = root_path / name
            relative = candidate.relative_to(workspace).as_posix()
            if candidate.is_symlink() or relative not in allowed_directories:
                raise ValueError(
                    "Persistent frontend workspace contains an unexpected directory or link: "
                    + relative
                )
            if Path(relative) in live_mount_targets:
                # The actual source tree is mounted at this exact target by
                # Compose.  Do not descend into live source files while
                # validating the named-volume seed; mount attestation checks
                # the source, target and readonly boundary separately.
                directories.remove(name)
        for name in filenames:
            candidate = root_path / name
            relative_path = candidate.relative_to(workspace)
            relative = relative_path.as_posix()
            if candidate.is_symlink() or relative not in allowed_files:
                raise ValueError(
                    "Persistent frontend workspace contains an unexpected file or link: "
                    + relative
                )
            try:
                metadata = candidate.lstat()
            except OSError as error:
                raise ValueError(
                    f"Cannot inspect persistent frontend seed file: {relative}"
                ) from error
            if not stat.S_ISREG(metadata.st_mode) or candidate.is_symlink():
                raise ValueError(
                    f"Persistent frontend seed file is not a regular file: {relative}"
                )
            if metadata.st_size > maximum:
                raise ValueError(
                    f"Persistent frontend seed file is too large: {relative}"
                )
            try:
                data = candidate.read_bytes()
            except OSError as error:
                raise ValueError(
                    f"Cannot read persistent frontend seed file: {relative}"
                ) from error
            if len(data) != metadata.st_size:
                raise ValueError(
                    f"Persistent frontend seed file changed while being read: {relative}"
                )
            expected_data = expected[relative_path]
            if expected_data is not None and data != expected_data:
                raise ValueError(
                    "Persistent frontend seed metadata does not match the selected checkout: "
                    + relative
                )


def _ensure_guest_directory(path, root):
    """Create one guest directory tree without traversing a link."""
    path = Path(path)
    root = Path(root)
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValueError(f"Frontend workspace path escapes its named volume: {path}") from error
    current = root
    if current.is_symlink() or (current.exists() and not current.is_dir()):
        raise ValueError(f"Frontend workspace root is not a real directory: {root}")
    current.mkdir(parents=True, exist_ok=True)
    for part in relative.parts:
        current = current / part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise ValueError(f"Frontend workspace path is not a real directory: {current}")
        current.mkdir(exist_ok=True)
    return current

def seed_guest(
    source,
    state,
    port,
    *,
    host_source_root,
    worktree_id,
    source_commit,
    manifest_path=None,
    frontend_cache_key=None,
):
    """Seed frontend dependency metadata into a Docker named volume.

    This is the volume-only counterpart of :func:`seed`.  It runs inside the
    frontend container, reads the readonly ``/opt/fullmag/source`` bind and
    writes only ``workspace`` plus the input manifest below the named
    ``/state/development`` volume.  It deliberately does not call
    ``local_volume`` or touch the Windows project storage.

    ``host_source_root`` is diagnostic provenance retained in the manifest;
    ``source`` is the container path used for reads.  A full commit and the
    Compose worktree identity are required because the guest cannot safely
    infer either from a Windows Git checkout.
    """
    def guest_read_regular(path, *, maximum):
        path = Path(path)
        try:
            metadata = path.lstat()
        except OSError as error:
            raise ValueError(f"Cannot inspect guest frontend input: {path}") from error
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Guest frontend input is not a regular file: {path}")
        if metadata.st_size > maximum:
            raise ValueError(f"Guest frontend input is too large: {path}")
        try:
            return path.read_bytes()
        except OSError as error:
            raise ValueError(f"Cannot read guest frontend input: {path}") from error

    source = Path(source)
    if not source.is_absolute() or source.is_symlink() or not source.is_dir():
        raise ValueError(f"Container source mount is not a real directory: {source}")
    state = Path(state)
    if not state.is_absolute() or state.is_symlink():
        raise ValueError("Docker frontend state root must be an absolute named-volume path")
    windows_source = isinstance(host_source_root, str) and re.fullmatch(
        r"(?:[A-Za-z]:[\\/].*|\\\\.*)", host_source_root
    )
    linux_source = (isinstance(host_source_root, str) and host_source_root.startswith("/")
                    and not host_source_root.startswith("//") and host_source_root != "/"
                    and "\\" not in host_source_root and ".." not in host_source_root.split("/")
                    and str(PurePosixPath(host_source_root)) == host_source_root
                    and not any(ord(char) < 32 or ord(char) == 127 for char in host_source_root))
    if not windows_source and not linux_source:
        raise ValueError("host_source_root must be an absolute diagnostic Windows or canonical Linux path")
    if not isinstance(worktree_id, str) or not re.fullmatch(
        r"[a-z0-9][a-z0-9._-]{0,127}", worktree_id
    ):
        raise ValueError("worktree_id is not a safe Compose identity")
    if not isinstance(source_commit, str) or not re.fullmatch(r"[a-f0-9]{40}", source_commit):
        raise ValueError("source_commit must be a lowercase full Git commit")
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("port must be an integer in 1024..65535")
    if frontend_cache_key is not None and not isinstance(frontend_cache_key, str):
        raise ValueError("frontend_cache_key must be a lowercase SHA-256")
    if frontend_cache_key is not None and not re.fullmatch(r"[a-f0-9]{64}", frontend_cache_key):
        raise ValueError("frontend_cache_key must be a lowercase SHA-256")
    if frontend_cache_key is not None:
        expected_manifest = (
            Path("/opt/fullmag/control")
            / frontend_cache_key
            / "development-inputs.json"
        )
        if manifest_path is None or Path(manifest_path) != expected_manifest:
            raise ValueError(
                "frontend input manifest must use the cache-key control namespace"
            )

    app = source / "apps" / "control-room"
    directories = []
    for name in DIRECTORIES:
        path = app / name
        if not path.is_dir() or path.is_symlink():
            raise ValueError(f"Missing live frontend source directory: {path}")
        directories.append(
            {
                "name": name,
                "source": host_source_root.rstrip("\\/")
                + "/apps/control-room/"
                + name,
                "target": WORKSPACE + "/apps/control-room/" + name,
            }
        )

    package_relative = Path("package.json")
    package_data = guest_read_regular(source / package_relative, maximum=16 * 1024 * 1024)
    patch_relatives = _pnpm_patch_relatives(source)
    relative_files = {
        Path(name) for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")
    }
    relative_files.update(patch_relatives)
    dependency_files = set(relative_files)
    relative_files.add(NEXT_CONFIG_RELATIVE)
    dependency_files.add(NEXT_CONFIG_RELATIVE)
    from windows.stage_workspace_frontend import (
        _direct_app_package_manifests,
        _parse_lock_importers,
    )

    importers = _parse_lock_importers(source / "pnpm-lock.yaml")
    for path in _direct_app_package_manifests(source, importers):
        relative = path.relative_to(source)
        relative_files.add(relative)
        dependency_files.add(relative)
    for path in app.iterdir():
        if path.suffix in {".ts", ".tsx", ".json", ".mjs", ".css"} and path.is_file():
            relative_files.add(path.relative_to(source))

    workspace = state / "workspace"
    workspace_present = workspace.exists() or workspace.is_symlink()
    if workspace.is_symlink() or (workspace_present and not workspace.is_dir()):
        raise ValueError("Persistent frontend workspace is missing or a reparse point")
    if workspace_present:
        _validate_guest_workspace(
            workspace, {relative: None for relative in relative_files}
        )
    else:
        try:
            workspace.mkdir(parents=True, exist_ok=False)
        except PermissionError as error:
            raise _named_volume_permission_error(workspace, error) from error

    # Compose attaches the four readonly Windows source mounts below these
    # targets.  Create their empty mountpoints in the named volume before the
    # service is created; ``create_host_path: false`` then remains fail-closed.
    for name in DIRECTORIES:
        mountpoint = workspace / "apps" / "control-room" / name
        try:
            _ensure_guest_directory(mountpoint, workspace)
        except PermissionError as error:
            raise _named_volume_permission_error(mountpoint, error) from error

    files = []
    dependency_entries = {}
    for relative in sorted(relative_files, key=str):
        try:
            data = (
                package_data
                if relative == package_relative
                else guest_read_regular(source / relative, maximum=16 * 1024 * 1024)
            )
        except OSError as error:
            if relative in patch_relatives:
                raise ValueError(f"Pnpm patch file is missing or unavailable: {relative}") from error
            raise
        target = workspace / relative
        try:
            _ensure_guest_directory(target.parent, workspace)
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise ValueError(f"Frontend workspace seed target is not a regular file: {relative}")
            if target.exists():
                existing = guest_read_regular(target, maximum=16 * 1024 * 1024)
                if existing != data:
                    raise ValueError(
                        "Persistent frontend seed metadata does not match the selected checkout: "
                        + relative.as_posix()
                    )
            else:
                with target.open("xb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
        except PermissionError as error:
            raise _named_volume_permission_error(target, error) from error
        digest = hashlib.sha256(data).hexdigest()
        relative_name = relative.as_posix()
        files.append({"relative": relative_name, "sha256": digest})
        if relative in dependency_files:
            dependency_entries[relative_name] = digest

    from docker_frontend_cache import default_toolpins, dependency_seed_digest, toolpins_digest

    toolpins = default_toolpins()
    manifest = {
        "schema": "fullmag.docker-development-inputs.v1",
        "source_root": host_source_root,
        "source_commit": source_commit,
        "source_selection": ("live_windows_selected_checkout" if windows_source
                             else "live_linux_selected_checkout"),
        "source_volume": str(source),
        "host_port": port,
        "worktree_id": worktree_id,
        **({"frontend_cache_key": frontend_cache_key} if frontend_cache_key is not None else {}),
        "dependency_seed_files": sorted(dependency_entries),
        "dependency_seed_sha256": dependency_seed_digest(dependency_entries),
        "toolpins": toolpins,
        "toolpins_sha256": toolpins_digest(toolpins),
        "workspace_root": WORKSPACE,
        "frontend_root": FRONTEND,
        "live_directories": directories,
        "files": files,
        "configuration_changes": "prepare_named_volume_workspace",
        "backend_build": "explicit_request_only",
    }
    destination = Path(manifest_path) if manifest_path is not None else state / "development-inputs.json"
    if not destination.is_absolute() or destination.is_symlink():
        raise ValueError("Frontend input manifest must be an absolute regular volume path")
    for ancestor in (destination.parent, *destination.parent.parents):
        if ancestor.is_symlink():
            raise ValueError(f"Frontend input manifest traverses a reparse point: {ancestor}")
        if ancestor == Path(ancestor.anchor):
            break
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
    except PermissionError as error:
        raise _named_volume_permission_error(destination.parent, error) from error
    if destination.exists() and not destination.is_file():
        raise ValueError("Frontend input manifest is not a regular file")
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        try:
            with temporary.open("xb") as stream:
                stream.write(
                    json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
                    + b"\n"
                )
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        except PermissionError as error:
            raise _named_volume_permission_error(destination, error) from error
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except PermissionError as error:
                raise _named_volume_permission_error(temporary, error) from error
    return manifest



def attest_mounts(actual, inputs, inputs_path=None):
    expected = {
        **({CONFIG_TARGET: str(inputs_path)} if inputs_path is not None else {}),
        **{entry["target"]: entry["source"] for entry in inputs["live_directories"]},
    }
    from run_managed_browser import host_path
    for target, source in expected.items():
        mounts = [mount for mount in actual["Mounts"] if mount["Destination"] == target]
        if (len(mounts) != 1 or mounts[0]["Type"] != "bind" or mounts[0]["RW"]
                or host_path(mounts[0]["Source"]) != Path(source).resolve()):
            raise ValueError(f"Live frontend readonly mount differs from its manifest: {target}")
