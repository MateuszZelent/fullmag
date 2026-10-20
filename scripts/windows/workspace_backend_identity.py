"""Fingerprint native workspace inputs separately from live Control Room sources."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from windows.stage_workspace_frontend import is_patch_relative, patch_file_relatives

INPUTS = ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "crates",
          "backends", "native", "apps/desktop/src-tauri", "scripts/windows",
          "scripts/fullmag_storage.py", "scripts/build_version.py", "scripts/rust",
          "packages/fullmag-py")
DEPENDENCY_INPUTS = ("packages/fullmag-py", "package.json", "pnpm-lock.yaml",
                     "pnpm-workspace.yaml", "apps/control-room/package.json",
                     ".npmrc", "rust-toolchain.toml", "patches")
INPUTS += DEPENDENCY_INPUTS


def is_native_workspace_input(relative):
    # Setuptools packages only src/. Test edits do not replace the installed
    # Python environment or compiled runtime, but remain in frozen inventories.
    return not relative.replace("\\", "/").startswith("packages/fullmag-py/tests/")


def fingerprint(repo, inputs=INPUTS):
    repo = Path(repo).resolve()
    names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others",
                                     "--exclude-standard", "--", *inputs], cwd=repo)
    normalized_inputs = tuple(str(value).replace("\\", "/") for value in inputs)
    patch_requested = any(
        value == "patches" or value.startswith("patches/") for value in normalized_inputs
    )
    paths = {
        relative
        for name in names.split(b"\0")
        if name
        for relative in (name.decode("utf-8"),)
        if is_native_workspace_input(relative)
        and (
            not patch_requested
            or not relative.startswith("patches/")
            or is_patch_relative(relative)
        )
    }
    if patch_requested:
        paths.update(
            relative.as_posix()
            for relative in patch_file_relatives(repo)
            if is_native_workspace_input(relative.as_posix())
        )
    paths = sorted(paths)
    result = hashlib.sha256()
    for relative in paths:
        path = repo / relative
        result.update(relative.encode("utf-8") + b"\0")
        if path.is_symlink():
            raise ValueError(f"Native source input must not be a symlink: {relative}")
        result.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"deleted")
    return {"schema": "fullmag.windows-workspace-backend-source.v1", "sha256": result.hexdigest(),
            "file_count": len(paths), "frontend_sources": "live_separate_identity"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--frontend", action="store_true")
    parser.add_argument("--dependencies", action="store_true")
    args = parser.parse_args()
    inputs = DEPENDENCY_INPUTS if args.dependencies else ("apps/control-room", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches") if args.frontend else INPUTS
    print(json.dumps(fingerprint(args.repo_root, inputs)))
