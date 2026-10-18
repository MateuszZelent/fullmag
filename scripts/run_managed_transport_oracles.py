"""Run only the fixed public FEM finite-lambda sinh oracle in a receipt-verified RAM container.

Never builds, compiles tests, runs arbitrary commands, or qualifies durable storage.
"""
from __future__ import annotations
import argparse
import json
import sys
import shlex
import subprocess
import os
import uuid
from pathlib import Path

import fullmag_storage as storage
from local_runner.worker_entrypoint import verify_source
from run_managed_antenna_ram import resolved_build, scientific_spec, attest
from run_managed_browser import digest, docker, read_json
from verify_saved_fem_archive_roundtrip import check_stamp

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/fullmag-py/src"))

PROFILE = "managed-transport-oracles-ram-cpu"
SCHEMA = "fullmag.managed-transport-oracles.v1"
SOURCE_FILES = ("scripts/run_managed_transport_oracles.py", "scripts/verify_transport_public_oracles.py",
                "crates/fullmag-runner/src/native_fem/steady_transport/artifact_identity.rs",
                "scripts/run_managed_antenna_ram.py", "scripts/run_managed_browser.py",
                "scripts/fullmag_storage.py", "scripts/local_runner/worker_entrypoint.py",
                "scripts/local_runner/build_executor.py", "scripts/verify_saved_fem_archive_roundtrip.py")


def transport_spec(image, source, package, inputs, export):
    spec = scientific_spec(image, source, package, inputs, export)
    manifest_code = ('import json,hashlib; from pathlib import Path; '
        'paths={"problem_ir_sha256":"/ram/prepared/64/problem_ir.json",'
        '"public_script_sha256":"/ram/prepared/64/problem.py",'
        '"artifact_sha256":"/ram/result/transport/fem_steady_spin_transport.json"}; '
        'print(json.dumps({"schema":"fullmag.managed_transport_output.v1",'
        '**{k:hashlib.sha256(Path(v).read_bytes()).hexdigest() for k,v in paths.items()}}))')
    command = ('set -eu; mkdir -p /ram/workspace/.fullmag; '
        'for path in /source/* /source/.[!.]*; do '
        '[ -e "$path" ] || continue; name="${path##*/}"; '
        '[ "$name" != ".fullmag" ] || exit 2; '
        'ln -s "$path" "/ram/workspace/$name"; done; '
        'cd /ram/workspace; '
        '/usr/bin/python3 -B /source/scripts/verify_transport_public_oracles.py '
        '--case fem-spin-sinh --materialize-assets --output-dir /ram/prepared '
        '> /export/preparation.log 2>&1; '
        'cp /ram/prepared/64/problem.py /export/problem.py; '
        'cp /ram/prepared/64/problem_ir.json /export/problem_ir.json; '
        'set +e; /package/bin/fullmag-bin run-problem-json-direct '
        '/ram/prepared/64/problem_ir.json --until 1e-15 --output-dir /ram/result '
        '> /export/solver.log 2>&1; solver_code=$?; set -e; '
        'if [ -d /ram/result ]; then cp -R /ram/result /export/result; fi; '
        'printf "%s\n" "$solver_code" > /export/solver-exit-code; '
        'if [ "$solver_code" -eq 0 ]; then /usr/bin/python3 -B -c ' + shlex.quote(manifest_code) +
        '; fi; exit "$solver_code"')
    spec["services"]["antenna"]["command"] = ["bash", "-c", command.replace("$", "$$")]
    return spec


def expected_public_ir(script, source_root):
    # A fresh interpreter imports the exact verified capsule, never the mutable host DSL.
    code = ("import json,sys; import fullmag as fm; "
        "from fullmag.runtime.loader import load_problem_from_script; "
        "loaded=load_problem_from_script(sys.argv[1],lightweight_assets=True); "
        "assert len(loaded.stages)==1; "
        "print(json.dumps(loaded.pipeline_base_problem().to_ir("
        "requested_backend=fm.BackendTarget('fem'),execution_mode=fm.ExecutionMode.STRICT,"
        "execution_precision=fm.ExecutionPrecision.DOUBLE,include_geometry_assets=False,"
        "entrypoint_kind='direct'),allow_nan=False))")
    environment = dict(os.environ, PYTHONPATH=str(source_root / "packages/fullmag-py/src"),
                       PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run([sys.executable, "-B", "-c", code, str(script)],
        capture_output=True, text=True, timeout=60, env=environment, cwd=source_root)
    if result.returncode:
        raise ValueError("frozen public DSL lowering failed: " + result.stderr)
    return json.loads(result.stdout)


def frozen_identity(source_root, script, ir_path, artifact):
    code = ("import json,sys; from pathlib import Path; import fullmag as fm; "
        "from fullmag.runtime.loader import load_problem_from_script; "
        "from verify_transport_public_oracles import load_module,validate_fem_identity; "
        "loaded=load_problem_from_script(Path(sys.argv[1]),lightweight_assets=True); "
        "assert len(loaded.stages)==1; "
        "expected=loaded.pipeline_base_problem().to_ir(requested_backend=fm.BackendTarget('fem'),"
        "execution_mode=fm.ExecutionMode.STRICT,execution_precision=fm.ExecutionPrecision.DOUBLE,"
        "include_geometry_assets=False,entrypoint_kind='direct'); "
        "print(json.dumps(validate_fem_identity(json.loads(Path(sys.argv[2]).read_text()),"
        "load_module(Path(sys.argv[3]),'fem'),expected),allow_nan=False))")
    environment = dict(os.environ,
        PYTHONPATH=os.pathsep.join((str(source_root / "packages/fullmag-py/src"), str(source_root / "scripts"))),
        PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run([sys.executable, "-B", "-c", code, str(script), str(ir_path), str(artifact)],
        capture_output=True, text=True, timeout=60, env=environment, cwd=source_root)
    if result.returncode:
        raise ValueError("frozen FEM identity validation failed: " + result.stderr)
    return json.loads(result.stdout)


def start(repo, job_id, commit, source_digest, native_snapshot_sha256):
    _, build, context, built, capsule, package = resolved_build(
        repo, job_id, commit, source_digest, native_snapshot_sha256)
    source = capsule / "tree"
    for name in SOURCE_FILES:
        if digest(source / name) != digest(repo / name):
            raise ValueError(f"managed source capsule does not contain current oracle contract: {name}")
    image = json.loads(docker("image", "inspect", context["image_digest"]))[0]
    if image.get("Id") != context["image_digest"] or image.get("Config", {}).get("Volumes"):
        raise ValueError("image identity or anonymous volumes invalid")
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    root = storage.validate_path(Path(layout["build_root"]) / "runs" / uuid.uuid4().hex,
                                 Path(layout["build_storage_root"]))
    root.mkdir(parents=True, exist_ok=False)
    (root / "input").mkdir()
    (root / "export").mkdir()
    spec = transport_spec(context["image_digest"], source, package, root / "input", root / "export")
    storage.atomic_json(root / "compose.json", spec)
    project = "fullmag-transport-ram-" + root.name
    receipt = {"schema": SCHEMA, "state": "starting", "qualification": "NOT VERIFIED",
        "physics_qualified": False, "unit_tests_compiled": False,
        "session_storage": "disposable_tmpfs", "durable_session_storage_qualified": False,
        "profile": PROFILE, "run_root": str(root), "managed_job_id": job_id,
        "compose_project": project, "native_source_identity": built["native_source_identity"],
        "source_digest": source_digest, "image_digest": context["image_digest"], "source_tree": str(source),
        "source_files_sha256": {name: digest(source / name) for name in SOURCE_FILES},
        "binary_sha256": digest(package / "bin/fullmag-bin"),
        "launcher_sha256": digest(__file__), "compose_sha256": digest(root / "compose.json"),
        "build_receipt_sha256": digest(build / "artifacts/build-receipt.json"),
        "lane": {"discretization": "fem", "device": "cpu", "precision": "double", "execution_mode": "strict"}}
    storage.atomic_json(root / "receipt.json", receipt)
    try:
        docker("compose", "-p", project, "-f", root / "compose.json", "up", "-d")
        container = docker("compose", "-p", project, "-f", root / "compose.json", "ps", "-a", "-q", "antenna").strip()
        if not container:
            raise ValueError("managed transport container missing")
        receipt["container_id"] = container
        attest(container, spec, project)
        receipt.update(state="launched_resources_retained", isolation="PASS")
    except Exception as error:
        receipt.update(state="failed_resources_retained", error=str(error))
        raise
    finally:
        storage.atomic_json(root / "receipt.json", receipt)
        print(json.dumps({"receipt": str(root / "receipt.json"), "state": receipt["state"]}))
    return root


def observe(repo, root):
    layout = storage.resolve_layout(repo, PROFILE)
    root = storage.validate_path(root, Path(layout["build_root"]) / "runs")
    receipt = read_json(root / "receipt.json")
    spec = read_json(root / "compose.json")
    if receipt.get("schema") != SCHEMA or receipt.get("run_root") != str(root) \
            or receipt.get("launcher_sha256") != digest(__file__) \
            or receipt.get("compose_sha256") != digest(root / "compose.json"):
        raise ValueError("managed transport receipt/launcher/spec differs")
    native = receipt["native_source_identity"]
    _, build, context, _, capsule, package = resolved_build(repo, receipt["managed_job_id"],
        native["head_commit_full"], receipt["source_digest"], native["source_snapshot_sha256"])
    for name in SOURCE_FILES:
        if digest(repo / name) != digest(capsule / "tree" / name):
            raise ValueError(f"host oracle contract differs from pinned source capsule: {name}")
    if receipt.get("source_tree") != str(capsule / "tree"):
        raise ValueError("managed frozen public DSL root differs")
    if receipt.get("build_receipt_sha256") != digest(build / "artifacts/build-receipt.json") \
            or receipt.get("binary_sha256") != digest(package / "bin/fullmag-bin") \
            or receipt.get("image_digest") != context["image_digest"] \
            or receipt.get("source_files_sha256") != {name: digest(capsule / "tree" / name) for name in SOURCE_FILES} \
            or spec != transport_spec(context["image_digest"], capsule / "tree", package,
                                      root / "input", root / "export") \
            or receipt.get("compose_project") != "fullmag-transport-ram-" + root.name:
        raise ValueError("managed source/build/package/spec binding differs")
    observed = attest(receipt["container_id"], spec, receipt["compose_project"])
    state = observed["State"]
    if state.get("Status") != "exited" or state["Running"]:
        return {"state": "pending", "run_root": str(root)}
    receipt.update(state="failed_resources_retained", solver_exit_code=state["ExitCode"], oom_killed=state["OOMKilled"])
    try:
        if state["ExitCode"] != 0 or state["OOMKilled"] or state.get("Error") \
                or (root / "export/solver-exit-code").read_text().strip() != "0":
            raise ValueError("managed solver/container failed; inspect retained full logs")
        log = root / "export/solver.log"
        check_stamp(log.read_text(encoding="utf-8"), native["head_commit_full"],
                    native["source_snapshot_sha256"], dirty=native["source_snapshot_dirty"])
        script, ir_path = root / "export/problem.py", root / "export/problem_ir.json"
        from verify_transport_public_oracles import source as fixture_source
        if script.read_text(encoding="utf-8") != fixture_source("fem-spin-sinh", 64):
            raise ValueError("retained public fixture differs")
        artifact = root / "export/result/transport/fem_steady_spin_transport.json"
        logs = docker("logs", receipt["container_id"])
        manifests = []
        for line in logs.splitlines():
            if line.startswith("{"):
                value = json.loads(line)
                if value.get("schema") == "fullmag.managed_transport_output.v1":
                    manifests.append(value)
        if len(manifests) != 1 or manifests[0] != {
                "schema": "fullmag.managed_transport_output.v1",
                "problem_ir_sha256": digest(ir_path), "artifact_sha256": digest(artifact),
                "public_script_sha256": digest(script)}:
            raise ValueError("retained outputs differ from the attested container output manifest")
        identity = frozen_identity(capsule / "tree", script, ir_path, artifact)
        verify_source(capsule, receipt["source_digest"])
        receipt.update(state="solver_succeeded_identity_verified", startup_identity="PASS",
            source_capsule_recheck="PASS", solver_log_sha256=digest(log),
            problem_ir_sha256=digest(ir_path), artifact_sha256=digest(artifact),
            public_script_sha256=digest(script), transport_identity=identity,
            container_output_manifest=manifests[0])
    except Exception as error:
        receipt["error"] = str(error)
        raise
    finally:
        storage.atomic_json(root / "receipt.json", receipt)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    starting = sub.add_parser("start")
    for flag in ("job-id", "commit", "source-digest", "native-snapshot-sha256"):
        starting.add_argument("--" + flag, required=True)
    sub.add_parser("observe").add_argument("--run-root", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "start":
        start(args.repo_root, args.job_id, args.commit, args.source_digest, args.native_snapshot_sha256)
    else:
        print(json.dumps(observe(args.repo_root, args.run_root)))
