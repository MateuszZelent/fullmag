"""Run only the fixed antenna inspection fixture with a disposable RAM session.

Requires a terminal managed CPU build. Never builds, installs, qualifies durable
storage, or promotes an inspection result to an LLG/FFT drive basis.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import uuid
from pathlib import Path

import fullmag_storage as storage
from local_runner.worker_entrypoint import verify_source
from run_managed_browser import (
    SYSTEM_MOUNT_TARGETS, compose_spec, digest, docker, host_path, read_json,
    validate_managed_build,
)
from verify_saved_fem_archive_roundtrip import check_stamp

PROFILE = "managed-antenna-ram-cpu"
FIXTURE_FILES = {
    "fem_antenna_current_source_inspection.py": "b738df85ceba8ebe24c379a6b9438c054b65900e3b1357e4928260f5f606b76a",
    "assets/fem_antenna_current_source.mesh.json": "5f6a3f3c280600ab0b60a1ce4f0668959687f4f41dcb1c205117a2815cea8fb3",
    "assets/fem_antenna_current_probe.mesh.json": "cfaa8173a7179482b045c58fb7ddda3bfecfe3f782a300c4726017066d74e97e",
}


def fixture_paths(repo):
    paths = {}
    for name, expected in FIXTURE_FILES.items():
        path = storage.validate_path(repo / "examples" / name, repo)
        if storage.is_link(path) or not path.is_file() or digest(path) != expected:
            raise ValueError(f"Fixed scientific input differs: {name}")
        paths[name] = path
    return paths


def scientific_spec(image, source, package, inputs, export):
    spec = compose_spec(image, source, package, export, 3104)
    service = spec["services"].pop("browser")
    spec["services"]["antenna"] = service
    service.pop("ports")
    service["network_mode"] = "none"
    service["cpus"] = 2
    service["volumes"] = [
        {"type": "bind", "source": str(path.resolve()), "target": target,
         "read_only": readonly}
        for path, target, readonly in ((source, "/source", True),
            (package, "/package", True), (inputs, "/input", True),
            (export, "/export", False))]
    service["tmpfs"] = ["/tmp:rw,nosuid,nodev,size=64m",
                        "/ram:rw,nosuid,nodev,size=768m,mode=1777"]
    env = service["environment"]
    env.update(FULLMAG_REPO_ROOT="/ram/workspace",
               FULLMAG_STATE_ROOT="/ram/workspace/.fullmag",
               FULLMAG_STATE_DIR="/ram/user-state", FULLMAG_API_PORT="0",
               FULLMAG_FEM_MESH_CACHE_DIR="/ram/workspace/.fullmag/mesh-cache",
               OMP_NUM_THREADS="2", FULLMAG_CPU_THREADS="2")
    # All solver-owned state stays in RAM. Export is a retained copy, not a
    # SessionStore on the Desktop bind mount. Preserve the solver exit code.
    entry = ('set -eu; mkdir -p /ram/workspace/.fullmag; '
             'for path in /source/* /source/.[!.]*; do '
             '[ -e "$path" ] || continue; name="${path##*/}"; '
             '[ "$name" != ".fullmag" ] || exit 2; '
             'ln -s "$path" "/ram/workspace/$name"; done; '
             'cd /ram/workspace; set +e; '
             '/package/bin/fullmag-bin /input/fem_antenna_current_source_inspection.py '
             '--headless --expect-script-sha256 ' + FIXTURE_FILES["fem_antenna_current_source_inspection.py"] +
             ' --output-dir /ram/result.zarr > /export/solver.log 2>&1; '
             'solver_code=$?; set -e; '
             'if [ -d /ram/result.zarr ]; then '
             'cp -R /ram/result.zarr /export/result.zarr; fi; '
             'printf "%s\n" "$solver_code" > /export/solver-exit-code; '
             'exit "$solver_code"')
    service["command"] = ["bash", "-c", entry.replace("$", "$$")]
    return spec


def attest(container, spec, project):
    observed = json.loads(docker("inspect", container))[0]
    service = spec["services"]["antenna"]
    expected = {(m["target"], str(Path(m["source"]).resolve()).lower(),
                 not m["read_only"]) for m in service["volumes"]}
    actual = {(m["Destination"], str(host_path(m["Source"])).lower(), m["RW"])
              for m in observed["Mounts"] if m["Type"] == "bind"
              and m["Destination"] not in SYSTEM_MOUNT_TARGETS}
    config = observed["HostConfig"]
    runtime = observed["Config"]
    labels = runtime.get("Labels", {})
    environment = runtime.get("Env", [])
    if runtime.get("Cmd") != [part.replace("$$", "$") for part in service["command"]] \
            or runtime.get("Entrypoint") not in (None, []) \
            or runtime.get("WorkingDir") != service["working_dir"] \
            or labels.get("com.docker.compose.project") != project \
            or labels.get("com.docker.compose.service") != "antenna" \
            or any([item for item in environment if item.split("=", 1)[0] == key]
                   != [f"{key}={value}"] for key, value in service["environment"].items()):
        raise ValueError("Scientific container command/environment/owner differs")
    if observed["Image"] != service["image"] or expected != actual \
            or any(m["Type"] == "volume" for m in observed["Mounts"]) \
            or config.get("NetworkMode") != "none" or config.get("PortBindings") \
            or not config.get("ReadonlyRootfs") or config.get("Privileged") \
            or set(config.get("CapDrop", [])) != {"ALL"} \
            or "no-new-privileges:true" not in config.get("SecurityOpt", []) \
            or observed["Config"].get("User") != "65532:65532" \
            or config.get("Memory") != 2 * 1024**3 \
            or config.get("NanoCpus") != 2 * 10**9 or config.get("PidsLimit") != 128 \
            or config.get("Tmpfs") != {
                "/tmp": "rw,nosuid,nodev,size=64m",
                "/ram": "rw,nosuid,nodev,size=768m,mode=1777"}:
        raise ValueError("Scientific container isolation differs from the approved RAM route")
    return observed


def resolved_build(repo, job_id, commit, source_digest, native_snapshot_sha256):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise ValueError("Full managed job ID required")
    layout = storage.resolve_layout(repo, PROFILE)
    base = Path(layout["storage_root"])
    build = storage.validate_path(Path(layout["runs_root"]) / job_id, base)
    context, built = validate_managed_build(build, commit,
        source_digest=source_digest, native_snapshot_sha256=native_snapshot_sha256)
    mounts = [m for m in read_json(build / "receipt.json").get("mounts", [])
              if len(m) == 4 and m[0] == "bind" and m[2] == "/source" and m[3] is False]
    if len(mounts) != 1:
        raise ValueError("Managed capsule mount missing or ambiguous")
    capsule = storage.validate_path(host_path(mounts[0][1]), base)
    manifest = verify_source(capsule, source_digest)
    if manifest.get("resolved_commit") != commit or manifest.get("source_mode") != "snapshot":
        raise ValueError("Scientific run requires the exact requested snapshot")
    package = storage.validate_path(build / "artifacts/outputs/.fullmag/local", build)
    return layout, build, context, built, capsule, package


def start(repo, job_id, commit, source_digest, native_snapshot_sha256):
    layout, build, context, built, capsule, package = resolved_build(
        repo, job_id, commit, source_digest, native_snapshot_sha256)
    paths = fixture_paths(repo)
    image = json.loads(docker("image", "inspect", context["image_digest"]))[0]
    if image.get("Id") != context["image_digest"] or image.get("Config", {}).get("Volumes"):
        raise ValueError("Image identity or anonymous volumes invalid")
    storage.initialize(layout)
    root = storage.validate_path(Path(layout["build_root"]) / "runs" / uuid.uuid4().hex,
                                 Path(layout["build_storage_root"]))
    root.mkdir(parents=True, exist_ok=False)
    inputs, export = root / "input", root / "export"
    inputs.mkdir()
    export.mkdir()
    for name, path in paths.items():
        target = inputs / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        if digest(target) != FIXTURE_FILES[name]:
            raise ValueError("Scientific input changed during staging")
    spec = scientific_spec(context["image_digest"], capsule / "tree", package, inputs, export)
    spec_path = root / "compose.json"
    storage.atomic_json(spec_path, spec)
    project = "fullmag-antenna-ram-" + root.name
    receipt = {"schema": "fullmag.managed-antenna-ram.v1", "state": "starting",
        "qualification": "NOT VERIFIED", "physics_qualified": False,
        "durable_session_storage_qualified": False, "session_storage": "disposable_tmpfs",
        "unit_tests_compiled": False, "profile": PROFILE, "run_root": str(root),
        "managed_job_id": job_id, "compose_project": project,
        "native_source_identity": built["native_source_identity"],
        "source_digest": source_digest, "image_digest": context["image_digest"],
        "fixture_sha256": FIXTURE_FILES, "launcher_sha256": digest(__file__),
        "compose_sha256": digest(spec_path),
        "build_receipt_sha256": digest(build / "artifacts/build-receipt.json")}
    receipt_path = root / "receipt.json"
    storage.atomic_json(receipt_path, receipt)
    try:
        args = ["compose", "-f", str(spec_path), "--project-name", project]
        docker(*args, "config", "--quiet")
        docker(*args, "up", "--detach", "--no-build", "--pull", "never")
        container = docker(*args, "ps", "--all", "--quiet", "antenna")
        receipt["container_id"] = container
        attest(container, spec, project)
        receipt.update(state="launched_resources_retained", isolation="PASS")
    except Exception as error:
        receipt.update(state="failed_resources_retained", error=str(error))
        raise
    finally:
        storage.atomic_json(receipt_path, receipt)
        print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"]}))
    return root


def observe(repo, root):
    layout = storage.resolve_layout(repo, PROFILE)
    root = storage.validate_path(root, Path(layout["build_root"]) / "runs")
    receipt = read_json(root / "receipt.json")
    spec = read_json(root / "compose.json")
    if receipt.get("schema") != "fullmag.managed-antenna-ram.v1" \
            or receipt.get("run_root") != str(root) \
            or receipt.get("compose_sha256") != digest(root / "compose.json"):
        raise ValueError("Scientific run identity changed")
    native = receipt["native_source_identity"]
    _, build, context, _, capsule, package = resolved_build(repo, receipt["managed_job_id"],
        native["head_commit_full"], receipt["source_digest"], native["source_snapshot_sha256"])
    for name, expected in FIXTURE_FILES.items():
        path = storage.validate_path(root / "input" / name, root / "input")
        if storage.is_link(path) or digest(path) != expected:
            raise ValueError("Staged scientific input changed")
    if receipt.get("build_receipt_sha256") != digest(build / "artifacts/build-receipt.json") \
            or receipt.get("image_digest") != context["image_digest"] \
            or receipt.get("fixture_sha256") != FIXTURE_FILES \
            or spec != scientific_spec(context["image_digest"], capsule / "tree",
                package, root / "input", root / "export") \
            or receipt.get("compose_project") != "fullmag-antenna-ram-" + root.name:
        raise ValueError("Scientific input/build/spec binding differs")
    observed = attest(receipt["container_id"], spec, receipt["compose_project"])
    state = observed["State"]
    if state.get("Status") != "exited" or state["Running"]:
        return {"state": "pending", "container_state": state.get("Status"), "run_root": str(root)}
    log = root / "export/solver.log"
    receipt.update(state="failed_resources_retained", solver_exit_code=state["ExitCode"],
                   oom_killed=state["OOMKilled"])
    try:
        if state["ExitCode"] != 0 or state["OOMKilled"] or state.get("Error"):
            raise ValueError("Scientific solver/container failed; read the retained full log")
        if (root / "export/solver-exit-code").read_text().strip() != "0":
            raise ValueError("Solver exit marker differs from container exit")
        native = receipt["native_source_identity"]
        check_stamp(log.read_text(encoding="utf-8"), native["head_commit_full"],
                    native["source_snapshot_sha256"], dirty=native["source_snapshot_dirty"])
        result = storage.validate_path(root / "export/result.zarr", root / "export")
        if storage.is_link(result) or not result.is_dir():
            raise ValueError("Scientific output bundle missing")
        receipt.update(state="solver_succeeded_comparison_pending", startup_identity="PASS",
                       solver_log_sha256=digest(log))
    except Exception as error:
        receipt["error"] = str(error)
        raise
    finally:
        storage.atomic_json(root / "receipt.json", receipt)
    return {"state": receipt["state"], "run_root": str(root)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    start_parser = sub.add_parser("start")
    for flag in ("job-id", "commit", "source-digest", "native-snapshot-sha256"):
        start_parser.add_argument("--" + flag, required=True)
    sub.add_parser("observe").add_argument("--run-root", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "start":
        start(args.repo_root, args.job_id, args.commit, args.source_digest, args.native_snapshot_sha256)
    else:
        print(json.dumps(observe(args.repo_root, args.run_root)))
