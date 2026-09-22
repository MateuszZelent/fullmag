#!/usr/bin/env python3
"""Execute a numerical DE pilot using a verified managed FEM build.

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
from validate_de_smoke_rows import validate_rows

MODEL = "examples/fem_de_film_100nm_numeric_pilot.py"
PILOTS = {
    "de100": (MODEL, None),
    "de-smoke-two": ("examples/fem_de_smoke_numeric.py", "two"),
    "de-smoke-five": ("examples/fem_de_smoke_numeric.py", "five"),
}


def pilot_model(pilot):
    if pilot not in PILOTS:
        raise managed.BenchmarkError("unknown DE pilot")
    return PILOTS[pilot][0]


def validate_model(context, pilot="de100"):
    model = pilot_model(pilot)
    entries = [entry for entry in context.manifest["files"] if entry["path"] == model]
    if len(entries) != 1:
        raise managed.BenchmarkError("DE pilot is absent from this build capsule; build the committed pilot first")
    path = managed._contained_path(context.source_tree, model, "DE pilot")
    managed._regular_file(path, "DE pilot")
    digest = managed._sha256_file(path)
    if digest != entries[0]["sha256"]:
        raise managed.BenchmarkError("DE pilot differs from the verified build capsule")
    return digest


def compose_command(context, output, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS, *, pilot="de100"):
    model = pilot_model(pilot)
    command = managed._compose_command(context, output, ("c1",), timeout_seconds=timeout_seconds)
    command[-1] = "\n".join([
        "set -euo pipefail",
        "cd /workspace/capsule",
        "runtime_bin=/workspace/.fullmag/local/bin/fullmag-bin",
        "source_script=/workspace/capsule/" + model,
        *(["export FULLMAG_DE_SMOKE_SAMPLING=" + PILOTS[pilot][1]] if PILOTS[pilot][1] else []),
        'test -x "$runtime_bin"',
        'test -f "$source_script"',
        "case_dir=/workspace/benchmark-output/" + pilot,
        'mkdir "$case_dir"',
        '"$runtime_bin" "$source_script" --backend fem --mode strict --precision double --headless --json --output-dir "$case_dir" >"$case_dir/runtime.log" 2>&1',
    ])
    return command


def execute(context, output, command, model_sha, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS, *, pilot="de100"):
    model = pilot_model(pilot)
    schema_name = "de100-pilot" if pilot == "de100" else "de-smoke"
    request = managed._run_request(context, output, (), command, timeout_seconds=timeout_seconds)
    request.update(schema=f"fullmag.{schema_name}.request.v1", operation=pilot + "-numerical-pilot",
                   public_model=model, cases=[pilot], sampling=PILOTS[pilot][1], model_sha256=model_sha,
                   orchestrator_sha256=managed._sha256_file(Path(__file__).resolve()))
    request["source"]["public_model_files"] = [model, *managed.PUBLIC_MODEL_FILES]
    request["scientific_gate"] = {"qualification": "NOT VERIFIED", "reason": "postsolve comparison and convergence required"}
    managed._write_new_json(output / "run-request.json", request)
    result = {"schema": f"fullmag.{schema_name}.result.v1", "pilot": pilot, "status": "failed",
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
            artifacts = managed._validate_case_artifacts(output / pilot, "c1")
            artifacts["case"] = pilot
            if PILOTS[pilot][1] is not None:
                artifacts["row_preflight"] = validate_rows(
                    output / pilot / "eigen/dispersion.csv", PILOTS[pilot][1])
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
    parser.add_argument("--pilot", choices=tuple(PILOTS), default="de100")
    args = parser.parse_args(argv)
    try:
        layout = managed.fullmag_storage.resolve_layout(args.repo_root, "windows-native")
        if not args.dry_run:
            managed.fullmag_storage.initialize(layout)
        if args.dry_run:
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            model_sha = validate_model(context, args.pilot)
            output = Path(layout["storage_root"]) / "runs" / layout["worktree_id"] / args.job_id / (args.pilot + "-preview")
            print(json.dumps({"status": "dry_run", "qualification": "NOT VERIFIED",
                              "model_sha256": model_sha,
                              "command": compose_command(context, output, pilot=args.pilot)}, indent=2))
            return 0
        with managed.fullmag_storage.build_lock(layout):
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            model_sha = validate_model(context, args.pilot)
            managed._inspect_image(managed.EXPECTED_IMAGE_DIGEST)
            output = managed._new_output_dir(context, args.output_dir)
            output.mkdir(parents=True, exist_ok=False)
            return execute(context, output, compose_command(context, output, pilot=args.pilot), model_sha, pilot=args.pilot)
    except (managed.BenchmarkError, managed.fullmag_storage.StorageError, OSError, ValueError, sqlite3.Error) as error:
        print(f"de100-pilot: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
