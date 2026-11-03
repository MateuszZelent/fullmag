#!/usr/bin/env python3
"""Run a pinned Göbel reference lane in the existing volume DEV backend."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.request import ProxyHandler, Request, build_opener

from docker_build_control import BuildControl, BuildControlError, canonical, toolchain_configuration
import docker_dev_codegen as codegen
from docker_dev_defaults import _discover_pins, resolve_defaults
from docker_volume_activate import _same_host_path
from docker_volume_dev import _retained_device_access
from fullmag_storage import resolve_layout, validate_path

PHASE = "goebel-scientific"
SCHEMA = "fullmag.goebel.volume-scientific.v1"
WORKER_SCHEMA = "fullmag.goebel.worker-terminal.v1"
SOURCE = "tests/standard_problems/bimeron/goebel_2019"
INPUTS = (
    "tests/__init__.py",
    "tests/standard_problems/__init__.py",
    f"{SOURCE}/__init__.py",
    f"{SOURCE}/common.py",
    f"{SOURCE}/scenario_fdm.py",
    f"{SOURCE}/verify.py",
    f"{SOURCE}/thresholds.v1.json",
)
FEM_LANE = "fem-periodic"
FEM_SCENARIO = f"{SOURCE}/scenario_fem_periodic.py"
FEM_MESH_MODULE = "tests.standard_problems.bimeron.goebel_2019.periodic_tet4_mesh"
FEM_MESH = f"{SOURCE}/goebel_periodic_tet4.mesh.json"
FEM_INPUTS = (*INPUTS[:4], FEM_SCENARIO, f"{SOURCE}/periodic_tet4_mesh.py")
FEM_COMPARISON_MODULE = "tests.standard_problems.bimeron.goebel_2019.compare_fem_fdm"
FEM_COMPARISON_INPUTS = (f"{SOURCE}/compare_fem_fdm.py", f"{SOURCE}/verify.py")
FEM_COMPARISON_FILE = "fem-fdm-comparison.json"
FEM_COMPARISON_SCHEMA = "goebel_fem_fdm_midplane_comparison.v1"
FEM_COMPARISON_TIMEOUT_S = 300
FDM_COMPARISON_FILES = tuple(
    f"stages/{stage}/{name}"
    for stage in ("stage_00_flat_relax", "stage_02_flat_run")
    for name in ("m_initial.json", "m_final.json", "metadata.json")
)
SOLVER = "/opt/fullmag/package/bin/fullmag-bin"
CONTROL = Path("/opt/fullmag/control")
RUNTIME_SOURCE = Path("/opt/fullmag/source")
STORE = Path("/state/runs/docker-all/session-store")
MAX_LOG = 32 * 1024 * 1024
MAX_RECORD = 8 * 1024 * 1024
SOLVER_TIMEOUT_S = 3600
FEM_TIMEOUT_S = 12 * 3600
MAX_TIMEOUT_S = 24 * 3600
MAX_FEM_TIMEOUT_S = 7 * 24 * 3600
MAX_MESH_BYTES = 64 * 1024 * 1024
MESH_TIMEOUT_S = 300
TOKEN = re.compile(r"[0-9a-f]{32}")
SHA = re.compile(r"[0-9a-f]{64}")
COMMIT = re.compile(r"[0-9a-f]{40}")
API_INSTANCE = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}")
TERMINAL = {"completed", "failed", "cancelled", "stopped"}
# The known deployed package predates only this CI fixture adjustment.
FIXTURE_ONLY = "apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def operation_root(token):
    require(isinstance(token, str) and TOKEN.fullmatch(token), "invalid operation attempt")
    return f"{PHASE}/attempts/{token}"


def result_root(token):
    operation_root(token)
    return Path("/state/runs/goebel-reference") / token


def lane_inputs(lane, fdm_reference=None):
    require(lane in {"fdm", FEM_LANE}, "unknown qualification lane")
    if fdm_reference is not None:
        require(lane == FEM_LANE, "FDM comparison is FEM-only")
        return (*FEM_INPUTS, *FEM_COMPARISON_INPUTS)
    return FEM_INPUTS if lane == FEM_LANE else INPUTS


def comparison_reference(lane, attempt, input_sha256):
    if attempt is None and input_sha256 is None:
        return None
    require(attempt is not None and input_sha256 is not None,
            "FDM comparison attempt and input SHA-256 must be paired")
    require(lane == FEM_LANE, "FDM comparison is FEM-only")
    require(isinstance(attempt, str) and TOKEN.fullmatch(attempt)
            and isinstance(input_sha256, str) and SHA.fullmatch(input_sha256),
            "FDM comparison requires an exact attempt and input SHA-256")
    return {"attempt": attempt, "input_sha256": input_sha256}


def validate_lane_args(args):
    lane_inputs(args.lane)
    if args.lane == FEM_LANE:
        require(isinstance(args.mesh_sha256, str) and SHA.fullmatch(args.mesh_sha256),
                "FEM periodic lane requires the exact generated mesh SHA-256")
    else:
        require(args.mesh_sha256 is None, "mesh SHA-256 applies only to the FEM periodic lane")
    deadline = args.solver_timeout_s
    if deadline is None:
        return FEM_TIMEOUT_S if args.lane == FEM_LANE else SOLVER_TIMEOUT_S
    maximum = MAX_FEM_TIMEOUT_S if args.lane == FEM_LANE else MAX_TIMEOUT_S
    require(type(deadline) is int and 60 <= deadline <= maximum, "invalid solver deadline")
    return deadline


def solver_environment(environment, lane):
    lane_inputs(lane)
    env = dict(environment)
    if lane == FEM_LANE:
        env.pop("FULLMAG_FDM_EXECUTION", None)
        env.pop("FULLMAG_FEM_ALL_IN_GPU", None)
        env.update(FULLMAG_FEM_EXECUTION="cpu", FULLMAG_RELAX_DEVICE="cpu", CUDA_VISIBLE_DEVICES="")
    else:
        env["FULLMAG_FDM_EXECUTION"] = "gpu"
    return env


def solver_arguments(token, lane="fdm"):
    operation = CONTROL / operation_root(token)
    results = result_root(token)
    lane_inputs(lane)
    scenario = FEM_SCENARIO if lane == FEM_LANE else f"{SOURCE}/scenario_fdm.py"
    backend = "fem" if lane == FEM_LANE else "fdm"
    return [
        SOLVER, str(operation / "inputs" / scenario),
        "--backend", backend, "--precision", "double", "--mode", "strict",
        "--headless", "--ui", "none", "--existing-output", "error",
        "--output-dir", str(results / "output.zarr"),
        "--workspace-root", str(results / "workspace"),
        "--receipt", str(operation / "script-launch.json"),
    ]


def validate_idle(record, terminal_run_id=None):
    require(
        API_INSTANCE.fullmatch(record.get("api_instance") or "")
        and record.get("health_status") == "ok"
        and record.get("queue_items") == []
        and record.get("queue_cursor") is None
        and record.get("runtime_state") == "ready"
        and record.get("runtime_configured") is True
        and record.get("native_leases_released") is True,
        "existing DEV group must be healthy and idle without native work or leases",
    )
    if record.get("active_session") is False:
        require(record.get("current_run_id") is None, "empty DEV workspace has a current run")
    else:
        require(
            record.get("active_session") is True and terminal_run_id
            and record.get("current_run_id") == terminal_run_id
            and record.get("current_run_status") in TERMINAL
            and record.get("solver_state") in (TERMINAL | {"idle"}),
            "current workspace must be empty or bound to the exact pinned terminal run",
        )


def expected_solver_sha(receipt, provenance):
    artifacts = [item for item in receipt.get("artifacts", [])
                 if isinstance(item, dict) and item.get("path") == "bin/fullmag-bin"]
    binary_hashes = provenance.get("binary_hashes", {})
    expected = artifacts[0].get("sha256") if len(artifacts) == 1 else None
    require(
        isinstance(expected, str) and SHA.fullmatch(expected)
        and isinstance(binary_hashes, dict) and binary_hashes.get("fullmag-bin") == expected,
        "CLI binary hash is not uniquely bound to both receipt and provenance",
    )
    return expected


def _git(root, *args):
    return subprocess.check_output(
        ["git", "-C", str(root), *args],
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        stderr=subprocess.PIPE,
    )


def _reference_inputs(repo, commit, lane="fdm", fdm_reference=None):
    require(_git(repo, "rev-parse", "HEAD").decode().strip() == commit,
            "reference checkout HEAD differs from the full source commit pin")
    data = {relative: _git(repo, "show", f"{commit}:{relative}") for relative in lane_inputs(lane, fdm_reference)}
    require(all(raw and len(raw) <= MAX_RECORD for raw in data.values()),
            "scientific source file is absent or exceeds the input bound")
    return data


def _runtime_source_binding(selected, probe, backend):
    mounted = probe.get("resolved_commit")
    require(isinstance(mounted, str) and COMMIT.fullmatch(mounted)
            and _git(selected, "rev-parse", "HEAD").decode().strip() == mounted
            and probe["native_source_identity"].get("head_commit_full") == mounted,
            "mounted runtime checkout differs from the live source probe")
    if codegen._source_matches(probe, backend):
        require(backend["worktree_state"] == "clean", "runtime package is not from a clean checkout")
        return mounted, []
    # Worktree identity normally includes the full commit. This one existing
    # package may be reused across the pinned, non-runtime CI fixture change.
    package = backend["commit"]
    require(backend["worktree_state"] == "clean"
            and probe["native_source_identity"].get("source_snapshot_dirty") is False,
            "runtime source or package contains uncommitted runtime inputs")
    _git(selected, "merge-base", "--is-ancestor", package, mounted)
    paths = _git(selected, "diff", "--name-only", "-z", package, mounted).decode().split("\0")
    changed = [path for path in paths if path]
    require(changed == [FIXTURE_ONLY], "mounted runtime sources differ from the admitted package")
    return mounted, changed


def _regular_json(path):
    require(path.resolve(strict=True) == path and path.is_file(), f"unsafe record {path.name}")
    with path.open("rb") as stream:
        raw = stream.read(MAX_RECORD + 1)
    require(len(raw) <= MAX_RECORD, f"record exceeds byte bound: {path.name}")
    return json.loads(raw)


def _idle_probe(terminal_run_id):
    opener = build_opener(ProxyHandler({}))
    instance = None

    def get(route):
        nonlocal instance
        headers = {} if instance is None else {"x-fullmag-api-instance": instance}
        with opener.open(Request("http://127.0.0.1:8081/v2/" + route, headers=headers), timeout=15) as response:
            identity = response.headers.get_all("x-fullmag-api-instance") or []
            require(response.status == 200 and len(identity) == 1 and
                    API_INSTANCE.fullmatch(identity[0]) and (instance is None or identity[0] == instance),
                    "idle probe did not retain one verified API instance")
            instance = identity[0]
            raw = response.read(MAX_RECORD + 1)
        require(len(raw) <= MAX_RECORD, "idle probe response exceeds byte bound")
        return json.loads(raw)

    health = get("platform/health")
    queue = get("platform/compute/queue")
    runtime = get("platform/runtime-service")
    require(queue.get("schema_version") == "compute_queue.v1", "unrecognized compute queue schema")
    current = None
    solver = None
    if health.get("active_session") is True:
        status = get("sessions/current/status")
        current = get("sessions/current/simulation/runs/current")
        solver = status.get("solver", {}).get("state")
        require(status.get("session", {}).get("session_id") == current.get("session_id")
                and status.get("run", {}).get("run_id") == current.get("run_id"),
                "workspace and current run identities differ")

    config = _regular_json(Path("/opt/fullmag/runtime-control/runtime-service/docker-all.json"))
    require(config.get("store_root") == str(STORE), "native session store is not group-owned")
    runs = STORE / "runs"
    require(runs.resolve() == runs, "native run directory has an alias")
    count = 0
    for run in runs.iterdir() if runs.exists() else ():
        count += 1
        require(count <= 1024 and run.resolve(strict=True) == run and run.is_dir(),
                "native run directory cannot be fully inspected safely")
        for folder in ("resource_leases", "preparation_resource_leases"):
            lease_directory = run / folder
            require(lease_directory.resolve() == lease_directory,
                    "native resource lease directory has an alias")
            for lease in lease_directory.rglob("*.json"):
                count += 1
                require(count <= 4096 and _regular_json(lease).get("state") == "released",
                        "a native run or preparation lease is not released")

    after = get("platform/health")
    after_queue = get("platform/compute/queue")
    require(health.get("active_session") is after.get("active_session")
            and after.get("status") == "ok" and after_queue == queue, "group activity changed during admission")
    if current is not None:
        require(get("sessions/current/simulation/runs/current") == current,
                "current run changed during admission")
    evidence = {
        "api_instance": instance,
        "active_session": health.get("active_session"),
        "health_status": health.get("status"),
        "queue_items": queue.get("items"),
        "queue_cursor": queue.get("next_cursor"),
        "runtime_state": runtime.get("state"),
        "runtime_configured": runtime.get("configured"),
        "current_run_id": current.get("run_id") if current else None,
        "current_run_status": current.get("status") if current else None,
        "solver_state": solver,
        "native_leases_released": True,
    }
    validate_idle(evidence, terminal_run_id)
    return evidence


def _file_sha(path):
    require(path.resolve(strict=True) == path and stat.S_ISREG(path.stat().st_mode),
            f"expected a regular pinned file: {path.name}")
    with path.open("rb") as stream:
        value = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def _generate_mesh(operation, input_root, env, mesh_sha):
    path = input_root / FEM_MESH
    require(not path.exists() and path.parent.resolve(strict=True) == path.parent,
            "generated mesh path already exists or has an alias")
    with (operation / "mesh-generation.log").open("xb") as log:
        subprocess.run(
            ["/usr/local/bin/python3", "-B", "-m", FEM_MESH_MODULE, str(path)],
            cwd=input_root, env=env, stdout=log, stderr=subprocess.STDOUT,
            timeout=MESH_TIMEOUT_S, check=True,
        )
        log.flush()
        os.fsync(log.fileno())
    require(0 < path.stat().st_size <= MAX_MESH_BYTES and _file_sha(path) == mesh_sha,
            "generated FEM mesh exceeds the bound or differs from the pinned SHA-256")
    return path


def publish_json_once(path, record, *, mode=0o600):
    """Publish a complete, durable record without replacing an existing one."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(canonical(record) + b"\n")
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
            os.link(temporary, path, follow_symlinks=False)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink()


def fdm_input_digest(bundle):
    """Hash the fixed FDM endpoint input manifest from the six exact file bytes."""
    return digest(canonical({relative: _file_sha(bundle / relative)
                             for relative in FDM_COMPARISON_FILES}))


def require_fdm_reference(bundle, reference):
    require(fdm_input_digest(bundle) == reference["input_sha256"],
            "FDM comparison inputs differ from the pinned SHA-256")


def compare_fem_reference(results, fdm_bundle, input_root, env, reference):
    """Report comparison outcomes independently of native solver completion."""
    verification = {"state": "not_verified", "fdm_reference": reference}
    try:
        require_fdm_reference(fdm_bundle, reference)
        try:
            completed = subprocess.run(
                ["/usr/local/bin/python3", "-B", "-m", FEM_COMPARISON_MODULE,
                 str(results / "output.zarr"), str(fdm_bundle)],
                cwd=input_root, env=env, capture_output=True, check=True,
                timeout=FEM_COMPARISON_TIMEOUT_S,
            )
        finally:
            require_fdm_reference(fdm_bundle, reference)
        report = codegen._read_json_bytes(completed.stdout, "Göbel FEM–FDM comparison", MAX_RECORD)
        require(report.get("schema_version") == FEM_COMPARISON_SCHEMA
                and set(report.get("stages", {})) == {"relaxed", "held"},
                "FEM–FDM comparison did not produce both endpoint stages")
    except Exception as error:
        verification["error"] = f"{type(error).__name__}: {error}"
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            verification["error"] += ": " + error.stderr[-2048:].decode(errors="replace").strip()
        report = {"schema_version": "fullmag.goebel.fem-fdm-comparison-failure.v1",
                  "status": "not_verified", "error": verification["error"]}
    else:
        verification["state"] = "compared"
        report["status"] = "compared"

    try:
        path = results / FEM_COMPARISON_FILE
        publish_json_once(path, {**report, "fdm_reference": reference}, mode=0o644)
        verification.update(path=path.name, sha256=_file_sha(path))
    except (OSError, ValueError, TypeError) as error:
        return {**verification, "state": "not_verified",
                "error": f"comparison report publication failed: {error}"}
    return verification


def _worker_entry(token, inputs, binary_sha, terminal_run_id, lane, mesh_sha, timeout, fdm_reference=None):
    operation = CONTROL / operation_root(token)
    require(operation.resolve(strict=True) == operation
            and (CONTROL / "active").read_text().strip() == token,
            "worker cannot publish outside its managed attempt")
    try:
        result = _run_worker(
            token, inputs, binary_sha, terminal_run_id, lane, mesh_sha, timeout, fdm_reference,
        )
    except Exception as error:
        result = {"worker_error": f"{type(error).__name__}: {error}"}
    terminal = {"schema": WORKER_SCHEMA, "attempt": token, "lane": lane,
                "inputs": inputs, "binary_sha256": binary_sha, "mesh_sha256": mesh_sha,
                "solver_timeout_s": timeout, "result": result}
    if fdm_reference is not None:
        terminal["fdm_reference"] = fdm_reference
    publish_json_once(operation / "worker-terminal.json", terminal)
    return terminal


def _run_worker(token, inputs, binary_sha, terminal_run_id, lane="fdm", mesh_sha=None,
                timeout=SOLVER_TIMEOUT_S, fdm_reference=None):
    relative = operation_root(token)
    operation = CONTROL / relative
    require(operation.resolve(strict=True) == operation
            and (CONTROL / "active").read_text().strip() == token,
            "qualification worker lacks the exact managed operation lease")
    require(set(inputs) == set(lane_inputs(lane, fdm_reference))
            and all(SHA.fullmatch(value) for value in inputs.values()),
            "scientific input set is not exactly the pinned canonical bundle")
    require(_file_sha(Path(SOLVER)) == binary_sha, "installed CLI changed after host admission")
    input_root = operation / "inputs"
    require(all(_file_sha(input_root / path) == expected for path, expected in inputs.items()),
            "staged scientific input bytes differ")
    require(not any(key.startswith("FULLMAG_GOEBEL_") for key in os.environ),
            "an inherited environment variable would change the reference scenario")
    if lane == "fdm":
        require(os.environ.get("FULLMAG_DOCKER_DEVICE_ACCESS") == "gpu",
                "fixed backend has no admitted GPU access")
    else:
        require(isinstance(mesh_sha, str) and SHA.fullmatch(mesh_sha),
                "missing exact FEM mesh pin")

    fdm_bundle = None
    if fdm_reference is not None:
        require(fdm_reference == comparison_reference(
            lane, fdm_reference.get("attempt"), fdm_reference.get("input_sha256"),
        ) and fdm_reference["attempt"] != token, "worker has invalid FDM comparison pins")
        fdm_bundle = result_root(fdm_reference["attempt"]) / "output.zarr"
    before = _idle_probe(terminal_run_id)
    results = result_root(token)
    require(results.resolve() == results, "result directory contains an alias")
    results.mkdir(parents=True, exist_ok=False)
    private_state = operation / "worker-state"
    private_state.mkdir(exist_ok=False)
    pythonpath = f"{input_root}:{RUNTIME_SOURCE}/packages/fullmag-py/src:/opt/fullmag/package"
    env = {**solver_environment(os.environ, lane), "FULLMAG_API_PORT": "0",
           "PYTHONPATH": pythonpath, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
           "FULLMAG_STATE_ROOT": str(private_state), "FULLMAG_STATE_DIR": str(private_state),
           "FULLMAG_RUNS_ROOT": str(private_state / "runs"),
           "FULLMAG_RUNTIME_CONTROL_ROOT": str(private_state),
           "HOME": str(private_state)}
    env.pop("FULLMAG_RUNTIME_SERVICE_CONFIG", None)
    env.pop("FULLMAG_RUNTIME_SERVICES_ROOT", None)
    mesh = _generate_mesh(operation, input_root, env, mesh_sha) if lane == FEM_LANE else None
    if mesh is not None:
        retained_mesh = results / "goebel_periodic_tet4.mesh.json"
        with mesh.open("rb") as source, retained_mesh.open("xb") as output:
            shutil.copyfileobj(source, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        require(_file_sha(retained_mesh) == mesh_sha, "retained FEM mesh does not match the pinned input")
    if fdm_bundle is not None:
        require_fdm_reference(fdm_bundle, fdm_reference)
    log = operation / "runtime.log"
    total = 0
    with log.open("xb") as output:
        command = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=15s",
                   str(timeout), *solver_arguments(token, lane)]
        # Python puts its working directory ahead of PYTHONPATH for -m.
        with subprocess.Popen(command, cwd=input_root, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
            assert process.stdout is not None
            for block in iter(lambda: process.stdout.read1(65536), b""):
                remaining = max(0, MAX_LOG - total)
                output.write(block[:remaining])
                output.flush()
                total += len(block)
            code = process.wait()
        os.fsync(output.fileno())

    after = _idle_probe(terminal_run_id)
    require(after == before, "group acquired competing activity or changed API during solve")
    require(_file_sha(Path(SOLVER)) == binary_sha
            and all(_file_sha(input_root / path) == expected for path, expected in inputs.items()),
            "solver or scientific source changed during solve")

    result = {"runtime_exit_code": code, "runtime_log_sha256": _file_sha(log),
              "runtime_log_bytes": min(total, MAX_LOG), "runtime_log_truncated": total > MAX_LOG,
              "idle_evidence": before, "verification": {"state": "not_run"}}
    if mesh is not None:
        require(_file_sha(mesh) == _file_sha(retained_mesh) == mesh_sha,
                "generated or retained FEM mesh changed during solve")
        result["mesh"] = {"control_path": str(mesh), "result_relative_path": retained_mesh.name,
                          "sha256": mesh_sha, "bytes": mesh.stat().st_size}
    script_receipt = operation / "script-launch.json"
    if script_receipt.is_file():
        result["script_launch_receipt_sha256"] = _file_sha(script_receipt)
    if code:
        return result
    if lane == FEM_LANE:
        require(script_receipt.is_file(), "FEM process completed without its managed launch receipt")
        launch = _regular_json(script_receipt)
        require(launch.get("outcome", {}).get("exit_code") == 0,
                "FEM launch receipt differs from the completed process")
        runtime = launch.get("resolved", {})
        require(runtime.get("backend") == "fem" and runtime.get("device") == "cpu"
                and runtime.get("precision") == "double" and runtime.get("mode") == "strict"
                and runtime.get("engine_id") == "fem_cpu_native" and runtime.get("fallback") is None,
                "FEM launch receipt does not attest strict FP64 native CPU without fallback")
        result["resolved_execution"] = runtime
        if fdm_bundle is not None:
            result["verification"] = compare_fem_reference(
                results, fdm_bundle, input_root, env, fdm_reference,
            )
        else:
            result["verification"] = {"state": "not_verified", "reason": "FEM comparison pending"}
        return result

    # The published validator and thresholds come from the exact reference
    # commit. Preserve the raw stage files and report their actual outcome.
    sys.path.insert(0, str(input_root))
    from tests.standard_problems.bimeron.goebel_2019.verify import verify_bundle
    try:
        report = verify_bundle(results / "output.zarr", log, raise_on_failure=False)
        require(report.get("check_count") == 19 and len(report.get("checks", {})) == 19,
                "the pinned verifier did not return its 19-check contract")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        report = {"status": "not_verified", "error": str(error)}
    raw = canonical(report) + b"\n"
    with (results / "verification.json").open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    result["verification"] = {
        "state": report["status"],
        "sha256": digest(raw),
        "passed_checks": sum(value is True for value in report.get("checks", {}).values()),
        "failed_checks": [key for key, value in report.get("checks", {}).items() if value is not True],
        "check_count": report.get("check_count"),
        "error": report.get("error"),
    }
    return result


def validate_worker_terminal(record, execution):
    require(isinstance(record, dict), "qualification worker has no terminal completion evidence")
    expected = {
        "schema": WORKER_SCHEMA,
        "attempt": execution["operation_attempt"],
        "lane": execution["lane"],
        "inputs": execution["reference_input_sha256"],
        "binary_sha256": execution["fullmag_binary_sha256"],
        "mesh_sha256": execution["mesh_sha256"],
        "solver_timeout_s": execution["solver_timeout_s"],
    }
    require(all(record.get(key) == value for key, value in expected.items())
            and record.get("fdm_reference") == execution.get("fdm_reference"),
            "worker completion differs from the exact admitted operation")
    result = record.get("result")
    require(isinstance(result, dict) and (
        isinstance(result.get("worker_error"), str)
        or (type(result.get("runtime_exit_code")) is int
            and SHA.fullmatch(result.get("runtime_log_sha256") or "")
            and isinstance(result.get("verification"), dict))),
        "qualification worker has no terminal completion evidence")
    if execution.get("fdm_reference") is not None and result.get("runtime_exit_code") == 0:
        require(result["verification"].get("fdm_reference") == execution["fdm_reference"],
                "worker verification differs from the exact FDM comparison pins")
    return result


def read_worker_terminal(backend_id, token):
    operation_root(token)
    command = (
        "import json,sys; from pathlib import Path; "
        "from docker_goebel_qualification import _file_sha,_regular_json,require; "
        "root=Path(sys.argv[1]); path=root/'worker-terminal.json'; "
        "record=_regular_json(path) if path.exists() else None; "
        "result=(record or {}).get('result',{}); "
        "expected=result.get('runtime_log_sha256'); "
        "actual=_file_sha(root/'runtime.log') if expected is not None else None; "
        "require(actual==expected,'durable worker runtime log differs'); "
        "comparison=(result.get('verification') or {}).get('sha256') "
        "if (record or {}).get('fdm_reference') is not None else None; "
        "require(comparison is None or _file_sha(Path(sys.argv[2]))==comparison,"
        "'durable FEM–FDM comparison report differs'); "
        "print(json.dumps({'terminal':record}))"
    )
    root = CONTROL / operation_root(token)
    stdout, _ = codegen._exec(
        backend_id, ("/usr/local/bin/python3", "-B", "-c", command, str(root),
                     str(result_root(token) / FEM_COMPARISON_FILE)), timeout=90,
        environment={"PYTHONPATH": str(root / "controller") + ":/opt/fullmag/source/scripts"},
    )
    return codegen._read_json_bytes(stdout, "Göbel durable worker completion")["terminal"]


# Run only in the authenticated retained helper. The original pending receipt
# is kept as history and terminal.json is the sole release signal.
RECONCILE_SCRIPT = r"""
set -euo pipefail
root=$1; token=$2; expected=$3
exec 9>"$root/reconcile.lock"; flock -n 9
test -f /control/active; test ! -L /control/active
test "$(cat /control/active)" = "$token"
test -f "$root/receipt.json"; test ! -L "$root/receipt.json"
test "$(sha256sum "$root/receipt.json" | cut -d ' ' -f1)" = "$expected"
test ! -e "$root/terminal.json"; test ! -L "$root/terminal.json"
IFS= read -r result
IFS= read -r terminal
temp=$(mktemp "$root/.reconcile.XXXXXXXX")
trap 'rm -f -- "$temp"' EXIT
printf '%s\n' "$result" > "$temp"; sync "$temp"
if test -e "$root/scientific-result.json"; then
    test ! -L "$root/scientific-result.json"
    cmp -s "$temp" "$root/scientific-result.json"
else
    ln "$temp" "$root/scientific-result.json"
fi
rm "$temp"
temp=$(mktemp "$root/.reconcile.XXXXXXXX")
printf '%s\n' "$terminal" > "$temp"; sync "$temp"
ln "$temp" "$root/terminal.json"; sync "$root"
"""


def observe_attempt(args, control, pins, hashes, timeout, fdm_reference=None):
    token = args.observe_attempt or args.reconcile_attempt
    root = operation_root(token)
    raw = control.read_bytes(root + "/receipt.json")
    receipt = json.loads(raw)
    expected_inputs = {
        "development_attempt": pins.attempt,
        "config_sha256": pins.config_sha256,
        "reference_source_commit": args.source_commit,
        "runtime_source_root": str(pins.source_root),
        "backend_container_id": pins.backend_container_id,
        "frontend_container_id": pins.frontend_container_id,
        "terminal_run_id": args.terminal_run_id,
        "source_inputs_sha256": hashes,
        "lane": args.lane,
        "mesh_sha256": args.mesh_sha256,
        "solver_timeout_s": timeout,
    }
    if fdm_reference is not None:
        expected_inputs["fdm_reference"] = fdm_reference
    require(receipt.get("attempt") == token and receipt.get("phase") == PHASE
            and receipt.get("compose_project") == control.project
            and receipt.get("inputs") == expected_inputs, "retained attempt does not match the explicit pins")
    execution = receipt.get("scientific_execution")
    require(isinstance(execution, dict), "retained attempt has no admitted worker")
    terminal = control.read(root + "/terminal.json", optional=True)
    if terminal is not None:
        require(terminal.get("attempt") == token and terminal.get("inputs") == expected_inputs
                and terminal.get("state") in {"succeeded", "failed-confirmed"},
                "retained terminal operation differs")
        print(json.dumps(terminal, ensure_ascii=False, sort_keys=True))
        return 0
    record = read_worker_terminal(pins.backend_container_id, token)
    if not args.reconcile_attempt:
        if record is not None:
            validate_worker_terminal(record, execution)
        print(json.dumps({"attempt": token, "state": receipt["state"], "worker_terminal": record},
                         ensure_ascii=False, sort_keys=True))
        return 0
    require(receipt.get("state") == "outcome-unknown-resources-retained",
            "reconcile requires a retained unknown operation")
    completed = validate_worker_terminal(record, execution)
    observed = codegen._inspect(pins.backend_container_id)
    require(observed.get("Image") == execution["image_id"]
            and observed.get("State", {}).get("StartedAt") == execution["backend_started_at"],
            "backend incarnation changed before reconcile")
    _, _, package_sha, _ = codegen._backend_documents(pins.backend_container_id)
    require(package_sha == execution["package_receipt_sha256"],
            "runtime package changed before reconcile")
    helper_id = receipt.get("helper_container_id")
    require(isinstance(helper_id, str) and re.fullmatch(r"[0-9a-f]{64}", helper_id),
            "retained operation lacks a pinned control helper")
    control._inspect_operation_helper({"receipt": receipt}, expected_id=helper_id)
    prior = control.read(root + "/scientific-result.json", optional=True)
    if prior is None:
        result = {**execution, **completed}
    else:
        require(all(prior.get(key) == value for key, value in {**execution, **completed}.items()),
                "existing scientific result differs from durable worker completion")
        result = prior
    state = "succeeded" if completed.get("runtime_exit_code") == 0 else "failed-confirmed"
    terminal = {**receipt, "state": state, "scientific_execution": result,
                "finished_at": time.time(), "reconciled_worker_terminal_sha256": digest(canonical(record))}
    codegen._exec(
        helper_id, ("/bin/bash", "-euo", "pipefail", "-c",
                    control._namespace_guard(RECONCILE_SCRIPT), "goebel-reconcile",
                    control.path(root), token, digest(raw)),
        timeout=90, input_bytes=canonical(result) + b"\n" + canonical(terminal) + b"\n",
    )
    require(control.read(root + "/terminal.json") == terminal,
            "reconciled terminal publication could not be confirmed")
    release = (
        "import pathlib,sys,time\n"
        "active = pathlib.Path('/opt/fullmag/control/active')\n"
        "for _ in range(25):\n"
        "    if not active.exists() or active.read_text().strip() != sys.argv[1]: break\n"
        "    time.sleep(0.2)\n"
        "else: raise RuntimeError('retained helper did not acknowledge terminal receipt')"
    )
    codegen._exec(pins.backend_container_id,
                  ("/usr/local/bin/python3", "-B", "-c", release, token), timeout=15)
    print(json.dumps(terminal, ensure_ascii=False, sort_keys=True))
    return 0

def run(args):
    timeout = validate_lane_args(args)
    fdm_reference = comparison_reference(args.lane, args.fdm_attempt, args.fdm_input_sha256)
    require(TOKEN.fullmatch(args.attempt) and SHA.fullmatch(args.config_sha256)
            and COMMIT.fullmatch(args.source_commit), "exact attempt, configuration and source pins required")
    require(args.terminal_run_id is None or RUN_ID.fullmatch(args.terminal_run_id), "invalid terminal run pin")
    repo = args.repo_root.resolve(strict=True)
    data = _reference_inputs(repo, args.source_commit, args.lane, fdm_reference)
    defaults = resolve_defaults(repo, source_root=args.source_root, port=args.port)
    pin_args = {"requested_port": args.port, "expected_attempt": args.attempt,
                "expected_config_sha256": args.config_sha256}
    pins = _discover_pins(repo, defaults, **pin_args)
    selected, identity = codegen._select_checkout(repo, args.source_root)
    require(pins.source_root == selected and identity["checkout_kind"] == "worktree",
            "qualification requires the exact selected registered DEV worktree")
    layout = resolve_layout(selected, "docker-all-gpu")
    compose = toolchain_configuration(selected, identity)
    control = BuildControl(identity, compose["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    retained = f"development/attempts/{args.attempt}"
    terminal = control.read(retained + "/terminal.json")
    document = control.read(retained + "/compose.json")
    device_access = _retained_device_access(terminal, document)
    allowed_access = {"cpu", "gpu"} if args.lane == FEM_LANE else {"gpu"}
    require(terminal.get("state") == "succeeded" and digest(canonical(document)) == args.config_sha256
            and device_access in allowed_access, "DEV attempt does not admit the selected lane")
    state = validate_path(Path(terminal["state_root"]), Path(layout["runtime_root"]), "qualification state root")
    state_mounts = [mount for mount in document["services"]["backend"]["volumes"]
                    if mount.get("target") == "/state"]
    require(len(state_mounts) == 1 and state_mounts[0].get("type") == "bind"
            and not state_mounts[0].get("read_only")
            and _same_host_path(state_mounts[0].get("source"), str(state)),
            "retained /state bind does not match the resolved qualification state root")
    hashes = {name: digest(raw) for name, raw in data.items()}
    if args.observe_attempt or args.reconcile_attempt:
        return observe_attempt(args, control, pins, hashes, timeout, fdm_reference)
    if fdm_reference is not None:
        fdm_path = state / "runs/goebel-reference" / fdm_reference["attempt"] / "output.zarr"
        require(validate_path(fdm_path, state, "FDM comparison bundle") == fdm_path,
                "FDM comparison bundle contains a path alias")
        require_fdm_reference(fdm_path, fdm_reference)

    operation_inputs = {
        "development_attempt": pins.attempt, "config_sha256": pins.config_sha256,
        "reference_source_commit": args.source_commit, "runtime_source_root": str(selected),
        "backend_container_id": pins.backend_container_id, "frontend_container_id": pins.frontend_container_id,
        "terminal_run_id": args.terminal_run_id, "source_inputs_sha256": hashes,
        "lane": args.lane, "mesh_sha256": args.mesh_sha256, "solver_timeout_s": timeout,
    }
    if fdm_reference is not None:
        operation_inputs["fdm_reference"] = fdm_reference
    with control.operation(PHASE, operation_inputs) as operation:
        require(_discover_pins(repo, defaults, **pin_args) == pins
                and control.read(retained + "/terminal.json") == terminal
                and control.read(retained + "/compose.json") == document, "DEV admission changed under operation lease")
        backend_id = pins.backend_container_id
        _, observed = codegen._running_service(identity["project_name"], "backend", identity, selected)
        require(observed.get("Id") == backend_id
                and codegen._backend_control_namespace(observed) == (control.namespace or "")
                and codegen._mount_for(observed, "/opt/fullmag/control").get("Name") == control.volume,
                "backend is outside the leased control namespace")
        state_mount = codegen._mount_for(observed, "/state")
        require(state_mount.get("Type") == "bind" and state_mount.get("RW") is True,
                "backend no longer has the admitted writable /state bind")
        receipt, provenance, receipt_sha, proof = codegen._backend_documents(backend_id)
        backend, provenance_sha, _ = codegen._validate_backend(receipt, provenance, receipt_sha, proof)
        binary_sha = expected_solver_sha(receipt, provenance)
        token = operation["receipt"]["attempt"]
        probe, _ = codegen._probe_source(backend_id, token)
        mounted_commit, excluded = _runtime_source_binding(selected, probe, backend)
        if args.lane == FEM_LANE:
            require(mounted_commit == backend["commit"],
                    "FEM periodic lane requires an exact rebuilt runtime package")
        host_output = validate_path(state / "runs/goebel-reference" / token, state, "qualification output")
        require(not host_output.exists(), "qualification output already exists")
        for relative, raw in data.items():
            control.write_bytes(operation["root"] + "/inputs/" + relative, raw)

        technical_log = str(CONTROL / operation["root"] / "runtime.log")
        result = {
            "schema": SCHEMA, "operation_attempt": token, "compose_project": control.project,
            "image_id": observed["Image"], "backend_container_id": backend_id,
            "backend_started_at": observed["State"]["StartedAt"],
            "reference_source_commit": args.source_commit, "reference_input_sha256": hashes,
            "package_commit": backend["commit"], "mounted_runtime_commit": mounted_commit,
            "mounted_non_runtime_changes": excluded, "package_source_snapshot_sha256": backend["snapshot"],
            "package_receipt_sha256": receipt_sha, "runtime_provenance_sha256": provenance_sha,
            "fullmag_binary_sha256": binary_sha, "runtime_log": technical_log,
            "output_root": str(host_output), "command": solver_arguments(token, args.lane),
            "lane": args.lane, "mesh_sha256": args.mesh_sha256, "solver_timeout_s": timeout,
        }
        if fdm_reference is not None:
            result["fdm_reference"] = fdm_reference
        operation["receipt"]["scientific_execution"] = result
        operation["receipt"]["helper_container_id"] = operation["helper_container_id"]
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        worker = (
            "import json,sys\n"
            "from docker_goebel_qualification import _worker_entry\n"
            "record = _worker_entry(sys.argv[1], json.loads(sys.argv[2]), sys.argv[3], "
            "sys.argv[4] or None, sys.argv[5], sys.argv[6] or None, int(sys.argv[7]), json.loads(sys.argv[8]))\n"
            "print(json.dumps(record))"
        )
        # The worker controller is copied from the verified reference commit,
        # independently of the backend's read-only runtime source mount.
        controller = Path(__file__).read_bytes()
        require(controller == _git(repo, "show", f"{args.source_commit}:scripts/docker_goebel_qualification.py"),
                "launcher bytes differ from the committed scientific controller")
        control.write_bytes(operation["root"] + "/controller/docker_goebel_qualification.py", controller)
        print(f"docker-dev-goebel: admitted {token}, runtime log {technical_log}",
              file=sys.stderr, flush=True)
        operation["daemon_pending"] = True
        stdout, _ = codegen._exec(
            backend_id, ("/usr/local/bin/python3", "-B", "-c", worker, token,
                         canonical(hashes).decode(), binary_sha, args.terminal_run_id or "",
                         args.lane, args.mesh_sha256 or "", str(timeout), canonical(fdm_reference).decode()),
            timeout=timeout + MESH_TIMEOUT_S + 300 + (FEM_COMPARISON_TIMEOUT_S if fdm_reference else 0), stdout_limit=MAX_RECORD,
            environment={"PYTHONPATH": str(CONTROL / operation["root"] / "controller")
                         + ":/opt/fullmag/source/scripts"},
        )
        record = codegen._read_json_bytes(stdout, "Göbel worker completion")
        completed = validate_worker_terminal(record, result)
        require(read_worker_terminal(backend_id, token) == record,
                "worker stdout differs from its durable completion record")
        if isinstance(completed.get("worker_error"), str):
            operation["daemon_pending"] = False
            raise BuildControlError("qualification worker rejected the run: " + completed["worker_error"])
        require(type(completed.get("runtime_exit_code")) is int
                and SHA.fullmatch(completed.get("runtime_log_sha256") or "")
                and isinstance(completed.get("verification"), dict),
                "qualification worker has no terminal completion evidence")
        operation["daemon_pending"] = False
        after, _ = codegen._probe_source(backend_id, token)
        require(_runtime_source_binding(selected, after, backend) == (mounted_commit, excluded)
                and probe.get("source_digest") == after.get("source_digest"),
                "mounted runtime source changed during qualification")
        _, _, final_package_sha, _ = codegen._backend_documents(backend_id)
        require(final_package_sha == receipt_sha, "runtime package changed during qualification")
        inspected = codegen._inspect(backend_id)
        require(codegen._service_identity(backend_id, inspected)
                == codegen._service_identity(backend_id, observed)
                and inspected["State"]["StartedAt"] == observed["State"]["StartedAt"]
                and inspected["Mounts"] == observed["Mounts"], "backend identity changed")
        result.update(completed, elapsed_seconds=time.time() - operation["receipt"]["started_at"])
        operation["receipt"]["state"] = ("succeeded" if completed["runtime_exit_code"] == 0
                                         else "failed-confirmed")
        control.write(operation["root"] + "/scientific-result.json", result)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return (2 if completed["runtime_exit_code"] else
                0 if completed["verification"].get("state") in {"passed", "compared"} else 3)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo-root", type=Path, required=True)
    result.add_argument("--source-root", type=Path, required=True)
    result.add_argument("--attempt", required=True)
    result.add_argument("--config-sha256", required=True)
    result.add_argument("--source-commit", required=True)
    result.add_argument("--port", type=int, required=True)
    result.add_argument("--terminal-run-id")
    result.add_argument("--lane", choices=("fdm", FEM_LANE), default="fdm")
    result.add_argument("--mesh-sha256")
    result.add_argument("--fdm-attempt")
    result.add_argument("--fdm-input-sha256")
    result.add_argument("--solver-timeout-s", type=int)
    recovery = result.add_mutually_exclusive_group()
    recovery.add_argument("--observe-attempt")
    recovery.add_argument("--reconcile-attempt")
    return result


def main():
    args = parser().parse_args()
    try:
        return run(args)
    except (BuildControlError, codegen.CodegenError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"docker-dev-goebel: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
