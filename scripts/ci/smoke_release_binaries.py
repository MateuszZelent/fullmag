"""Smoke the CLI and read the build identity embedded in the actual API binary."""
import json
import os
from pathlib import Path
import subprocess
import sys


def smoke(bin_dir: Path, commit: str) -> None:
    suffix = ".exe" if os.name == "nt" else ""
    cli = bin_dir.resolve() / f"fullmag{suffix}"
    api = bin_dir.resolve() / f"fullmag-api{suffix}"
    subprocess.run([cli, "--help"], stdout=subprocess.DEVNULL, check=True, timeout=60)
    result = subprocess.run([api, "--print-openapi-v2"], stdout=subprocess.PIPE,
                            check=True, timeout=60)
    schema = json.loads(result.stdout)
    if not schema["paths"] or schema["x-fullmag-build-identity"]["git_commit"] != commit:
        raise ValueError(f"{api} did not identify itself as build {commit}")
    print(f"Verified CLI and API build {commit} in {bin_dir}")


if __name__ == "__main__":
    smoke(Path(sys.argv[1]), sys.argv[2])
