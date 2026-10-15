"""Seed isolated Linux frontend metadata and bind live Windows source folders."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re

import fullmag_storage as storage
from windows_folder_host import local_volume, read_owned_regular

DIRECTORIES = ("app", "src", "public", "scripts")
WORKSPACE = "/state/development/workspace"
FRONTEND = "/state/development/cache"
CONFIG_TARGET = "/run/fullmag/development-inputs.json"


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


def seed(source, state, port):
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
    relative_files = {Path(name) for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")}
    # The lockfile can contain other workspace importers. Copy their manifests,
    # while only Control Room sources become live container inputs.
    from windows.stage_workspace_frontend import _parse_lock_importers, _direct_app_package_manifests
    importers = _parse_lock_importers(source / "pnpm-lock.yaml")
    for path in _direct_app_package_manifests(source, importers):
        relative_files.add(path.relative_to(source))
    for path in app.iterdir():
        # Generated cache junctions may be broken from another host/runtime.
        # Do not follow them merely to enumerate regular app configuration.
        if path.suffix in {".ts", ".tsx", ".json", ".mjs", ".css"} and path.is_file():
            relative_files.add(path.relative_to(source))
    files = []
    destination = storage.validate_path(state / "development/workspace", state,
                                        "isolated Docker frontend workspace")
    destination.mkdir(parents=True, exist_ok=False)
    for relative in sorted(relative_files, key=str):
        data = read_owned_regular(source / relative, maximum=16 * 1024 * 1024)
        target = storage.validate_path(destination / relative, destination, "frontend metadata")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        files.append({"relative": relative.as_posix(), "sha256": hashlib.sha256(data).hexdigest()})
    commit = storage.git(source, "rev-parse", "HEAD")
    if commit != initial_commit:
        raise ValueError("Main checkout HEAD changed during frontend metadata capture")
    for file in files:
        current = read_owned_regular(source / file["relative"], maximum=16 * 1024 * 1024)
        if hashlib.sha256(current).hexdigest() != file["sha256"]:
            raise ValueError("Frontend configuration changed during metadata capture: " + file["relative"])
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Live source checkout has no full commit identity")
    return {"schema": "fullmag.docker-development-inputs.v1", "source_root": str(source),
            "source_commit": commit, "source_selection": "live_windows_selected_checkout",
            "source_volume": source_volume, "host_port": port,
            "workspace_root": WORKSPACE, "frontend_root": FRONTEND,
            "live_directories": directories, "files": files,
            "configuration_changes": "prepare_new_workspace",
            "backend_build": "explicit_managed_runner_only"}



def attest_mounts(actual, inputs, inputs_path):
    expected = {CONFIG_TARGET: str(inputs_path),
                **{entry["target"]: entry["source"] for entry in inputs["live_directories"]}}
    from run_managed_browser import host_path
    for target, source in expected.items():
        mounts = [mount for mount in actual["Mounts"] if mount["Destination"] == target]
        if (len(mounts) != 1 or mounts[0]["Type"] != "bind" or mounts[0]["RW"]
                or host_path(mounts[0]["Source"]) != Path(source).resolve()):
            raise ValueError(f"Live frontend readonly mount differs from its manifest: {target}")
