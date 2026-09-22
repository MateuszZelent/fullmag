"""Versioned standalone DE input, separate from attested compiled runtime.

No build capsule is changed. The runtime and Python package always come from
its verified capsule; only the user-authored standalone model is a new input.
"""
from __future__ import annotations
import hashlib
import re
import subprocess
from pathlib import Path

MODEL = "examples/fem_de_smoke_numeric.py"


def load_model(repo: Path, commit: str):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("model commit must be a full lowercase Git SHA")
    resolved = subprocess.run(["git", "rev-parse", commit + "^{commit}"], cwd=repo,
                              capture_output=True, check=True, timeout=30).stdout.decode().strip()
    if resolved != commit:
        raise ValueError("model ref must identify a commit, not a tag object")
    data = subprocess.run(["git", "show", commit + ":" + MODEL], cwd=repo,
                          capture_output=True, check=True, timeout=30).stdout
    if not data or len(data) > 1024*1024:
        raise ValueError("standalone model is empty or oversized")
    compile(data, MODEL, "exec")
    return data, {"kind": "versioned_standalone_input", "commit": commit,
                  "path": MODEL, "sha256": hashlib.sha256(data).hexdigest()}


def stage_model(output: Path, data: bytes):
    with (output / "model-input.py").open("xb") as stream:
        stream.write(data)


def verify_model(output: Path, identity):
    path = output / "model-input.py"
    if path.is_symlink() or not path.is_file():
        raise ValueError("standalone model input is missing or became a link")
    if hashlib.sha256(path.read_bytes()).hexdigest() != identity["sha256"]:
        raise ValueError("standalone model input hash mismatch")
