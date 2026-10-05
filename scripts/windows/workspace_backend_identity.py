"""Fingerprint native workspace inputs separately from live Control Room sources."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

INPUTS = ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "crates",
          "backends", "native", "apps/desktop/src-tauri", "scripts/windows",
          "scripts/fullmag_storage.py", "scripts/volatile_build_storage.py", "scripts/build_version.py", "scripts/rust",
          "packages/fullmag-py")
DEPENDENCY_INPUTS = ("packages/fullmag-py", "package.json", "pnpm-lock.yaml",
                     "pnpm-workspace.yaml", "apps/control-room/package.json",
                     ".npmrc", "rust-toolchain.toml")
INPUTS += DEPENDENCY_INPUTS


def fingerprint(repo, inputs=INPUTS):
    repo = Path(repo).resolve()
    names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others",
                                     "--exclude-standard", "--", *inputs], cwd=repo)
    paths = sorted(set(name.decode("utf-8") for name in names.split(b"\0") if name))
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
    inputs = DEPENDENCY_INPUTS if args.dependencies else ("apps/control-room", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml") if args.frontend else INPUTS
    print(json.dumps(fingerprint(args.repo_root, inputs)))
