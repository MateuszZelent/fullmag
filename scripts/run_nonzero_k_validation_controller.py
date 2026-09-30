"""Observe one managed build and run pinned nonzero-k smoke cases.

Never write Python bytecode into the immutable source capsule.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

TERMINAL_FAILURES = {"failed", "cancelled", "rejected", "blocked", "interrupted"}


def python_command(script, *args):
    return [sys.executable, "-B", str(script), *map(str, args)]


def child_environment():
    return {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}


def build_state(data, config):
    if data.get("job_id") != config["job_id"] or data.get("source_digest") != config["source_digest"]:
        raise ValueError("managed build source identity mismatch")
    state = data["state"]
    if state == "succeeded" and data.get("exit_code") != 0:
        raise ValueError("successful managed build has nonzero or missing exit code")
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    root = args.config.resolve().parent
    config = json.loads(args.config.read_text(encoding="utf-8"))
    repo, capsule = Path(config["worktree"]), Path(config["capsule"])
    env = child_environment()
    last = None
    while True:
        # The mutable client observes; the immutable capsule is only a run input.
        result = subprocess.run(python_command(repo / "scripts/local_runner_cli.py",
            "--worktree", repo, "status", config["job_id"]), cwd=repo,
            env=env, capture_output=True, text=True, encoding="utf-8")
        if result.returncode:
            print("Observation unavailable; retaining same job", flush=True)
            time.sleep(30)
            continue
        state = build_state(json.loads(result.stdout), config)
        if state != last:
            print("build_state=" + state, flush=True)
            last = state
        if state == "succeeded": break
        if state in TERMINAL_FAILURES:
            raise SystemExit("Build terminal: " + state)
        time.sleep(30)
    cases = [("gamma-t3", "de-smoke-k0", "3")]
    for layers in ("3", "6", "9"):
        cases += [("de-t" + layers, "de-smoke-k25", layers),
                  ("bv-t" + layers, "de-smoke-bv-k25", layers)]
    results = []
    for name, pilot, layers in cases:
        print("Starting " + name, flush=True)
        command = python_command(capsule / "scripts/run_de_100nm_pilot.py",
            "--repo-root", repo, "--job-id", config["job_id"], "--pilot", pilot,
            "--model-ref", config["model_ref"], "--mesh-level", "L2",
            "--thickness-layers", layers, "--output-dir", root / name)
        with (root / (name + "-wrapper.log")).open("x", encoding="utf-8") as log:
            completed = subprocess.run(command, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
        results.append({"case": name, "wrapper_exit": completed.returncode, "output": str(root / name)})
        (root / "controller-results.json").write_text(json.dumps({
            "qualification": "NOT VERIFIED", "job_id": config["job_id"],
            "source_digest": config["source_digest"], "results": results}, indent=2), encoding="utf-8")
        print(name + " wrapper_exit=" + str(completed.returncode), flush=True)
        if completed.returncode:
            raise SystemExit("Stopped at first failed pilot; diagnosis required")
    print("wrappers_terminal_requires_scientific_review", flush=True)


if __name__ == "__main__":
    main()
