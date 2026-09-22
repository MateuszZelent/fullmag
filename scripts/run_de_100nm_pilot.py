#!/usr/bin/env python3
"""Execute the DE 100 nm numerical pilot using a verified managed FEM build.

Execution receipts are deliberately unqualified: dispersion comparison and mesh/
airbox convergence are separate scientific gates. No analytic solver is invoked.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import run_comsol_dispersion_benchmark as managed

MODEL = "examples/fem_de_film_100nm_numeric_pilot.py"


def validate_model(context):
    entries = [entry for entry in context.manifest["files"] if entry["path"] == MODEL]
    if len(entries) != 1:
        raise managed.BenchmarkError("DE pilot is absent from this build capsule; build the committed pilot first")
    path = managed._contained_path(context.source_tree, MODEL, "DE pilot")
    managed._regular_file(path, "DE pilot")
    digest = managed._sha256_file(path)
    if digest != entries[0]["sha256"]:
        raise managed.BenchmarkError("DE pilot differs from the verified build capsule")
    return digest


def compose_command(context, output, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS):
    command = managed._compose_command(context, output, ("c1",), timeout_seconds=timeout_seconds)
    command[-1] = "\n".join([
        "set -euo pipefail",
        "cd /workspace/capsule",
        "runtime_bin=/workspace/.fullmag/local/bin/fullmag-bin",
        "source_script=/workspace/capsule/" + MODEL,
        'test -x "$runtime_bin"',
        'test -f "$source_script"',
        "case_dir=/workspace/benchmark-output/de100",
        'mkdir "$case_dir"',
        '"$runtime_bin" "$source_script" --backend fem --mode strict --precision double --headless --json --output-dir "$case_dir" >"$case_dir/runtime.log" 2>&1',
    ])
    return command


def execute(context, output, command, model_sha, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS):
    request = managed._run_request(context, output, (), command, timeout_seconds=timeout_seconds)
    request.update(schema="fullmag.de100-pilot.request.v1", operation="de100-numerical-pilot",
                   public_model=MODEL, cases=["de100"], model_sha256=model_sha,
                   orchestrator_sha256=managed._sha256_file(Path(__file__).resolve()))
    request["source"]["public_model_files"] = [MODEL, *managed.PUBLIC_MODEL_FILES]
    request["scientific_gate"] = {"qualification": "NOT VERIFIED", "reason": "postsolve comparison and convergence required"}
    managed._write_new_json(output / "run-request.json", request)
    result = {"schema": "fullmag.de100-pilot.result.v1", "status": "failed",
              "qualification": "NOT VERIFIED", "started_at_unix": time.time(),
              "job": request["job"], "source": request["source"], "runtime": request["runtime"],
              "model_sha256": model_sha, "return_code": None, "artifacts": None,
              "container_cleanup": {"status": "not_requested"}}
    try:
        with (output / "compose.log").open("x", encoding="utf-8") as log:
            completed = subprocess.run(command, cwd=context.layout["repo_root"],
                                       env=managed._compose_environment(context.layout),
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                       check=False, timeout=math.ceil(timeout_seconds)
                                       + managed.CONTAINER_TIMEOUT_GRACE_SECONDS
                                       + managed.HOST_COMPOSE_GRACE_SECONDS)
        result["return_code"] = completed.returncode
        if completed.returncode == 0:
            # C1 artifact requirements include complex modes and full potential.
            # This reuses the artifact contract only, not C1 scientific parameters.
            artifacts = managed._validate_case_artifacts(output / "de100", "c1")
            artifacts["case"] = "de100"
            result.update(status="completed_unqualified", artifacts=artifacts)
    except subprocess.TimeoutExpired:
        result["error"] = "host Compose watchdog expired after the container deadline and grace period"
    except KeyboardInterrupt:
        result["error"] = "pilot interrupted by operator"
    except (OSError, ValueError, managed.BenchmarkError) as error:
        result["error"] = str(error)
    finally:
        if result["return_code"] != 0:
            try:
                result["container_cleanup"] = managed._cleanup_benchmark_container(context, output)
            except (managed.BenchmarkError, OSError, ValueError, TypeError, KeyboardInterrupt) as error:
                result["container_cleanup"] = {"status": "blocked", "reason": str(error)}
        result["finished_at_unix"] = time.time()
        managed._write_new_json(output / "run-result.json", result)
    print(json.dumps({"output_dir": str(output), **result}, indent=2))
    return 0 if result["status"] == "completed_unqualified" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        layout = managed.fullmag_storage.resolve_layout(args.repo_root, "windows-native")
        if not args.dry_run:
            managed.fullmag_storage.initialize(layout)
        if args.dry_run:
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            model_sha = validate_model(context)
            output = Path(layout["storage_root"]) / "runs" / layout["worktree_id"] / args.job_id / "de100-preview"
            print(json.dumps({"status": "dry_run", "qualification": "NOT VERIFIED",
                              "model_sha256": model_sha,
                              "command": compose_command(context, output)}, indent=2))
            return 0
        with managed.fullmag_storage.build_lock(layout):
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            model_sha = validate_model(context)
            managed._inspect_image(managed.EXPECTED_IMAGE_DIGEST)
            output = managed._new_output_dir(context, args.output_dir)
            output.mkdir(parents=True, exist_ok=False)
            return execute(context, output, compose_command(context, output), model_sha)
    except (managed.BenchmarkError, managed.fullmag_storage.StorageError, OSError, ValueError, sqlite3.Error) as error:
        print(f"de100-pilot: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
