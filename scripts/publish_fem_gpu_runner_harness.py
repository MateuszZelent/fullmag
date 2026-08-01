#!/usr/bin/env python3
"""Publish an immutable, hash-addressed Task 6 FEM GPU runner harness."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def loader_trace(worker: Path, candidate_root: Path) -> str:
    env = os.environ.copy()
    candidate_lib = str((candidate_root / "lib").resolve())
    inherited = env.get("LD_LIBRARY_PATH", "")
    env["LD_LIBRARY_PATH"] = (
        f"{candidate_lib}:{inherited}" if inherited else candidate_lib
    )
    result = subprocess.run(
        ["ldd", str(worker)], capture_output=True, text=True, env=env, check=False
    )
    if result.returncode != 0:
        raise SystemExit(f"ldd failed for runner harness: {result.stderr.strip()}")
    return result.stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--output-parent", type=Path, required=True)
    args = parser.parse_args()

    worker = args.worker.resolve()
    candidate_root = args.candidate_root.resolve()
    candidate_manifest = candidate_root / "manifest.json"
    if not worker.is_file() or not os.access(worker, os.X_OK):
        raise SystemExit(f"built runner is missing or not executable: {worker}")
    if not candidate_manifest.is_file():
        raise SystemExit(f"candidate manifest is missing: {candidate_manifest}")

    worker_sha256 = sha256(worker)
    candidate_manifest_sha256 = sha256(candidate_manifest)
    harness_id = hashlib.sha256(
        f"{worker_sha256}:{candidate_manifest_sha256}".encode("ascii")
    ).hexdigest()
    destination = args.output_parent.resolve() / harness_id
    if destination.exists():
        raise SystemExit(f"runner harness already exists: {destination}")

    trace = loader_trace(worker, candidate_root)
    staging = args.output_parent.resolve() / f".{worker_sha256}.staging.{os.getpid()}"
    staging.mkdir(parents=True, exist_ok=False)
    try:
        published_worker = staging / "fullmag-fem-gpu-bin"
        shutil.copy2(worker, published_worker)
        published_worker.chmod(0o755)
        (staging / "loader-trace.txt").write_text(trace, encoding="utf-8")
        manifest = {
            "schema": "fullmag.fem_gpu.runner_harness.v1",
            "worker": published_worker.name,
            "worker_sha256": worker_sha256,
            "source_candidate_manifest_sha256": candidate_manifest_sha256,
            "harness_id": harness_id,
            "loader_trace": "loader-trace.txt",
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        staging.rename(destination)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    print(destination / "fullmag-fem-gpu-bin")


if __name__ == "__main__":
    main()
