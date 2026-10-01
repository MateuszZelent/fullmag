"""Observe one managed build and run pinned nonzero-k smoke cases.

Never write Python bytecode into the immutable source capsule.
"""
import argparse
import hashlib
import re
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


def validate_observer_root(config_path, layout, job_id):
    if not isinstance(job_id, str) or re.fullmatch(r"[a-f0-9]{32}", job_id) is None:
        raise ValueError("invalid managed job ID")
    expected = (Path(layout["storage_root"]) / "runs" / layout["worktree_id"]
                / "scientific-batches/nonzero-k-validation" / job_id).resolve()
    import fullmag_storage
    actual = fullmag_storage.validate_path(
        Path(config_path), Path(layout["storage_root"]), "nonzero-k observer config").parent
    if actual != expected:
        raise ValueError("observer configuration must use scientific-batches, outside coordinator job root")
    return actual


def validation_cases(series="thickness"):
    """Return actual solver runs; signed samples are never mirrored results."""
    convergence = [("gamma-t3", "de-smoke-k0", "3")]
    for layers in ("3", "6", "9"):
        convergence += [("de-t" + layers, "de-smoke-k25", layers),
                        ("bv-t" + layers, "de-smoke-bv-k25", layers)]
    if series == "thickness":
        return convergence
    if series != "signed-13":
        raise ValueError("unsupported nonzero-k validation series")
    cases = [convergence[0], ("bv-k0-t3", "de-smoke-bv-k0", "3"),
             *convergence[1:3]]
    for magnitude in (25, 20, 15, 10, 5, 2):
        for signed in ((-magnitude,) if magnitude == 25 else (magnitude, -magnitude)):
            label = "m" + str(-signed) if signed < 0 else "p" + str(signed)
            for geometry, prefix in (("de", ""), ("bv", "bv-")):
                cases.append((geometry + "-k" + label + "-t3",
                              "de-smoke-" + prefix + "k" + str(signed), "3"))
    return cases + convergence[3:]


def prepare_controller_config(job, layout, model_ref, series="thickness"):
    """Prepare observer state without reserving the coordinator-owned job root."""
    validation_cases(series)
    job_id = job.get("job_id")
    if job.get("worktree_id") != layout["worktree_id"]:
        raise ValueError("job worktree identity mismatch")
    if not isinstance(model_ref, str) or re.fullmatch(r"[a-f0-9]{40}", model_ref) is None:
        raise ValueError("model ref must be a full commit SHA")
    storage = Path(layout["storage_root"])
    path = storage / "runs" / layout["worktree_id"] / "scientific-batches/nonzero-k-validation" / str(job_id) / "controller-config.json"
    validate_observer_root(path, layout, job_id)
    digest = job.get("source_digest")
    if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
        raise ValueError("invalid managed source digest")
    relative = job["payload"]["capsule_relative"]
    expected_prefix = "runs/" + layout["worktree_id"] + "/"
    if not isinstance(relative, str) or re.fullmatch(re.escape(expected_prefix) + r"[a-f0-9]{32}/source", relative) is None:
        raise ValueError("noncanonical managed source capsule")
    config = {"worktree": str(Path(layout["repo_root"])),
              "capsule": str(storage / relative / "tree"), "job_id": job_id,
              "source_digest": digest, "model_ref": model_ref, "series": series,
              "controller_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(config, stream, indent=2)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--config", type=Path)
    action.add_argument("--prepare-job", type=Path, help="saved managed submission JSON")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--model-ref", help="full commit SHA for observer preparation")
    parser.add_argument("--series", choices=("thickness", "signed-13"), help="series to pin during preparation")
    args = parser.parse_args()
    import fullmag_storage
    if args.prepare_job:
        job = json.loads(args.prepare_job.read_text(encoding="utf-8"))
        layout = fullmag_storage.resolve_layout(args.repo_root, "windows-native")
        print(prepare_controller_config(job, layout, args.model_ref, args.series or "thickness"), flush=True)
        return
    if args.series is not None:
        parser.error("--series is only valid with --prepare-job; execution uses pinned config")
    config = json.loads(args.config.read_text(encoding="utf-8"))
    layout = fullmag_storage.resolve_layout(config["worktree"], "windows-native")
    root = validate_observer_root(args.config, layout, config["job_id"])
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
    cases = validation_cases(config.get("series", "thickness"))
    convergence_names = {name for name, _, _ in validation_cases("thickness")}
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
        (root / "convergence-results.json").write_text(json.dumps({
            "qualification": "NOT VERIFIED", "job_id": config["job_id"],
            "source_digest": config["source_digest"],
            "results": [r for r in results if r["case"] in convergence_names]}, indent=2), encoding="utf-8")
        print(name + " wrapper_exit=" + str(completed.returncode), flush=True)
        if completed.returncode:
            raise SystemExit("Stopped at first failed pilot; diagnosis required")
    print("wrappers_terminal_requires_scientific_review", flush=True)


if __name__ == "__main__":
    main()
