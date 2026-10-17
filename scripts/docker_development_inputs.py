"""Seed isolated Linux frontend metadata and bind live Windows source folders.

The selected checkout's root package manifest and its ``patches/**/*.patch``
files are immutable dependency inputs.  The application source directories
remain live readonly mounts.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re

import fullmag_storage as storage
from windows_folder_host import local_volume, read_owned_regular

DIRECTORIES = ("app", "src", "public", "scripts")
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
    selected = Path(source_root).resolve(strict=True) if source_root else main_checkout(repo)
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


def seed(source, state, port, *, reuse_from=None):
    if os.name != "nt":
        raise ValueError("Live Docker development sources require native Windows preflight")
    source = source.resolve(strict=True)
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
    if reuse_from is not None:
        if not destination.is_dir() or destination.is_symlink():
            raise ValueError("Persistent frontend workspace is missing or a reparse point")
    else:
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
        if reuse_from is None:
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
            "source_commit": commit, "source_selection": "live_windows_selected_checkout",
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



def attest_mounts(actual, inputs, inputs_path):
    expected = {CONFIG_TARGET: str(inputs_path),
                **{entry["target"]: entry["source"] for entry in inputs["live_directories"]}}
    from run_managed_browser import host_path
    for target, source in expected.items():
        mounts = [mount for mount in actual["Mounts"] if mount["Destination"] == target]
        if (len(mounts) != 1 or mounts[0]["Type"] != "bind" or mounts[0]["RW"]
                or host_path(mounts[0]["Source"]) != Path(source).resolve()):
            raise ValueError(f"Live frontend readonly mount differs from its manifest: {target}")
