"""Explicit Windows-only disposable build storage; never runtime/artifact storage."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fullmag_storage as storage

ROOT_ENV = "FULLMAG_WINDOWS_VOLATILE_ROOT"
ROOT_SCHEMA = "fullmag.windows-volatile-root.v1"
PROFILE_SCHEMA = "fullmag.windows-volatile-build.v1"
MARKER = ".fullmag-volatile-build.json"


def _checked(path, root, label):
    return storage.validate_path(path, root, label)


def _layout(repo_root, profile):
    resolver_env = {key: value for key, value in os.environ.items()
                    if key in {"FULLMAG_PROJECT_STORAGE_ROOT", "FULLMAG_WINDOWS_BUILD_ROOT", "FULLMAG_BUILD_ROOT"}}
    return storage.resolve_layout(repo_root, profile, environ=resolver_env)


def _marker(path, expected, create=False):
    _checked(path, path.parent, "volatile owner marker")
    if path.exists():
        if not path.is_file() or json.loads(path.read_text(encoding="utf-8")) != expected:
            raise storage.StorageError(f"Volatile build marker belongs to another owner: {path}")
    elif create:
        # Exclusive creation: an existing marker is never replaced or repaired.
        with path.open("x", encoding="utf-8") as stream:
            json.dump(expected, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
    else:
        raise storage.StorageError(f"Volatile build marker is missing: {path}")


def configured_root(repo, env=None):
    values = dict(os.environ if env is None else env)
    main = Path(storage.worktree_records(Path(repo))[0]["worktree"])
    value = values.get(ROOT_ENV, storage.storage_dotenv(main).get(ROOT_ENV, "")).strip()
    return storage.absolute(value, ROOT_ENV) if value else None


def _validate_root(root, layout):
    if root == Path(root.anchor):
        raise storage.StorageError("Volatile build root cannot be a filesystem root")
    for boundary in (layout["project_root"], layout["storage_root"], layout["repo_root"], layout["worktrees_root"]):
        if storage.inside(root, Path(boundary)) or storage.inside(Path(boundary), root):
            raise storage.StorageError(f"Volatile build storage overlaps permanent data or checkout: {root}")
    for registration in storage.worktree_records(Path(layout["repo_root"])):
        checkout = Path(registration["worktree"])
        if checkout.is_absolute() and (storage.inside(root, checkout) or storage.inside(checkout, root)):
            raise storage.StorageError("Volatile build storage overlaps a registered worktree")
    _checked(root, root, "volatile build root")
    if not Path(root.anchor).is_dir():
        raise storage.StorageError(f"Configured volatile drive is unavailable: {root.anchor}. Mount it before building")
    if os.name == "nt":
        drive_type = ctypes.windll.kernel32.GetDriveTypeW(str(root.anchor))
        if drive_type not in (3, 6):
            raise storage.StorageError("Volatile native compiler inputs require a local fixed/RAM drive")


def _supports_normalized_paths(directory):
    # Rust/Tauri canonicalize requires this Windows API. Some RAM-disk
    # drivers support ordinary file I/O but return ERROR_INVALID_FUNCTION.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(str(directory), 0, 7, None, 3, 0x02000000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise storage.StorageError(f"Cannot open volatile directory for preflight: {ctypes.get_last_error()}")
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        result = kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
        if not result:
            error = ctypes.get_last_error()
            if error == 1:
                return False
            raise storage.StorageError(f"Volatile path normalization failed: Win32 error {error}")
        return True
    finally:
        kernel.CloseHandle(handle)


def prepare(repo_root, profile, build_root=None):
    if os.name != "nt":
        return {"enabled": False}
    # A launcher may already have a profile-specific frontend environment.
    # It is not a generic resolver override. Resolve only storage configuration.
    layout = _layout(repo_root, profile)
    if build_root is not None and Path(build_root).resolve() != Path(layout["build_root"]).resolve():
        raise storage.StorageError("Volatile workspace differs from the resolved durable build root")
    root = configured_root(repo_root)
    if root is None:
        return {"enabled": False}
    _validate_root(root, layout)
    root_marker = root / ".fullmag-volatile-root.json"
    if root.exists() and not root_marker.exists() and any(root.iterdir()):
        raise storage.StorageError("Unregistered nonempty volatile root cannot be adopted")
    root.mkdir(parents=True, exist_ok=True)
    _marker(root_marker, {"schema": ROOT_SCHEMA, "project_root": layout["project_root"]}, create=True)
    work = _checked(root / "builds" / layout["worktree_id"] / profile, root, "volatile build profile")
    work.mkdir(parents=True, exist_ok=True)
    marker = {"schema": PROFILE_SCHEMA, "project_root": layout["project_root"],
              "repo_root": layout["repo_root"], "worktree_id": layout["worktree_id"], "profile": profile,
              "durable_build_root": layout["build_root"]}
    if not (work / MARKER).exists() and any(work.iterdir()):
        raise storage.StorageError("Unregistered nonempty volatile profile cannot be adopted")
    _marker(work / MARKER, marker, create=True)
    temp = _checked(work / "tmp", root, "volatile compiler temporary directory")
    temp.mkdir(exist_ok=True)
    inputs = _checked(work / "compiler-inputs", root, "volatile compiler input root")
    mirror_enabled = _supports_normalized_paths(temp)
    return {"enabled": True, "root": str(root), "temp_root": str(temp),
            "compiler_inputs_root": str(inputs), "durable_build_root": layout["build_root"],
            "compiler_inputs_enabled": mirror_enabled,
            "available_bytes": shutil.disk_usage(root).free}


def validate_working_root(build_root, working_root):
    candidate = storage.absolute(working_root, "volatile compiler inputs")
    _checked(candidate, candidate, "volatile compiler inputs")
    marker_path = candidate.parent / MARKER
    _checked(marker_path, candidate.parent, "volatile profile marker")
    value = json.loads(marker_path.read_text(encoding="utf-8"))
    fields = {"schema", "project_root", "repo_root", "worktree_id", "profile", "durable_build_root"}
    if (not isinstance(value, dict) or set(value) != fields or value.get("schema") != PROFILE_SCHEMA
            or any(not isinstance(value.get(key), str) for key in fields)
            or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", str(value.get("profile", "")))
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", str(value.get("worktree_id", "")))
            or Path(value["durable_build_root"]).resolve() != Path(build_root).resolve()):
        raise storage.StorageError("Volatile compiler inputs have a different durable build owner")
    root = configured_root(value["repo_root"])
    if root is None or candidate != root / "builds" / value["worktree_id"] / value["profile"] / "compiler-inputs":
        raise storage.StorageError("Compiler input working root differs from explicit host configuration")
    layout = _layout(value["repo_root"], value["profile"])
    if (layout["project_root"] != value["project_root"] or layout["worktree_id"] != value["worktree_id"]
            or Path(layout["build_root"]).resolve() != Path(build_root).resolve()):
        raise storage.StorageError("Volatile compiler owner differs from the registered checkout/profile")
    _validate_root(root, layout)
    _marker(root / ".fullmag-volatile-root.json", {"schema": ROOT_SCHEMA, "project_root": value["project_root"]})
    return candidate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--build-root", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.repo_root, args.profile, args.build_root)))
        return 0
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"Volatile build storage refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
