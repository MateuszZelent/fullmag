#!/usr/bin/env python3
"""Run the pinned Göbel FDM qualification in the existing volume DEV backend."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
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
SCENARIO = f"{SOURCE}/scenario_fdm.py"
SOLVER = "/opt/fullmag/package/bin/fullmag-bin"
CONTROL = Path("/opt/fullmag/control")
RUNTIME_SOURCE = Path("/opt/fullmag/source")
STORE = Path("/state/runs/docker-all/session-store")
MAX_LOG = 32 * 1024 * 1024
MAX_RECORD = 8 * 1024 * 1024
SOLVER_TIMEOUT_S = 3600
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


def solver_arguments(token):
    operation = CONTROL / operation_root(token)
    results = result_root(token)
    return [
        SOLVER, str(operation / "inputs" / SCENARIO),
        "--backend", "fdm", "--precision", "double", "--mode", "strict",
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


def _reference_inputs(repo, commit):
    require(_git(repo, "rev-parse", "HEAD").decode().strip() == commit,
            "reference checkout HEAD differs from the full source commit pin")
    data = {relative: _git(repo, "show", f"{commit}:{relative}") for relative in INPUTS}
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


def _run_worker(token, inputs, binary_sha, terminal_run_id):
    relative = operation_root(token)
    operation = CONTROL / relative
    require(operation.resolve(strict=True) == operation
            and (CONTROL / "active").read_text().strip() == token,
            "qualification worker lacks the exact managed operation lease")
    require(set(inputs) == set(INPUTS) and all(SHA.fullmatch(value) for value in inputs.values()),
            "scientific input set is not exactly the pinned canonical bundle")
    require(_file_sha(Path(SOLVER)) == binary_sha, "installed CLI changed after host admission")
    input_root = operation / "inputs"
    require(all(_file_sha(input_root / path) == expected for path, expected in inputs.items()),
            "staged scientific input bytes differ")
    require(not any(key.startswith("FULLMAG_GOEBEL_") for key in os.environ),
            "an inherited environment variable would change the reference scenario")
    require(os.environ.get("FULLMAG_DOCKER_DEVICE_ACCESS") == "gpu",
            "fixed backend has no admitted GPU access")

    before = _idle_probe(terminal_run_id)
    results = result_root(token)
    require(results.resolve() == results, "result directory contains an alias")
    results.mkdir(parents=True, exist_ok=False)
    private_state = operation / "worker-state"
    private_state.mkdir(exist_ok=False)
    pythonpath = f"{input_root}:{RUNTIME_SOURCE}/packages/fullmag-py/src:/opt/fullmag/package"
    env = {**os.environ, "FULLMAG_FDM_EXECUTION": "gpu", "FULLMAG_API_PORT": "0",
           "PYTHONPATH": pythonpath, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
           "FULLMAG_STATE_ROOT": str(private_state), "FULLMAG_STATE_DIR": str(private_state),
           "FULLMAG_RUNS_ROOT": str(private_state / "runs"),
           "FULLMAG_RUNTIME_CONTROL_ROOT": str(private_state),
           "HOME": str(private_state)}
    env.pop("FULLMAG_RUNTIME_SERVICE_CONFIG", None)
    env.pop("FULLMAG_RUNTIME_SERVICES_ROOT", None)
    log = operation / "runtime.log"
    total = 0
    with log.open("xb") as output:
        command = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=15s",
                   str(SOLVER_TIMEOUT_S), *solver_arguments(token)]
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
    script_receipt = operation / "script-launch.json"
    if script_receipt.is_file():
        result["script_launch_receipt_sha256"] = _file_sha(script_receipt)
    if code:
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


def run(args):
    require(TOKEN.fullmatch(args.attempt) and SHA.fullmatch(args.config_sha256)
            and COMMIT.fullmatch(args.source_commit), "exact attempt, configuration and source pins required")
    require(args.terminal_run_id is None or RUN_ID.fullmatch(args.terminal_run_id), "invalid terminal run pin")
    repo = args.repo_root.resolve(strict=True)
    data = _reference_inputs(repo, args.source_commit)
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
    require(terminal.get("state") == "succeeded" and digest(canonical(document)) == args.config_sha256
            and _retained_device_access(terminal, document) == "gpu", "DEV attempt is not a successful GPU admission")
    state = validate_path(Path(terminal["state_root"]), Path(layout["runtime_root"]), "qualification state root")
    state_mounts = [mount for mount in document["services"]["backend"]["volumes"]
                    if mount.get("target") == "/state"]
    require(len(state_mounts) == 1 and state_mounts[0].get("type") == "bind"
            and not state_mounts[0].get("read_only")
            and _same_host_path(state_mounts[0].get("source"), str(state)),
            "retained /state bind does not match the resolved qualification state root")
    hashes = {name: digest(raw) for name, raw in data.items()}

    with control.operation(PHASE, {
        "development_attempt": pins.attempt, "config_sha256": pins.config_sha256,
        "reference_source_commit": args.source_commit, "runtime_source_root": str(selected),
        "backend_container_id": pins.backend_container_id, "frontend_container_id": pins.frontend_container_id,
        "terminal_run_id": args.terminal_run_id, "source_inputs_sha256": hashes,
    }) as operation:
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
        host_output = validate_path(state / "runs/goebel-reference" / token, state, "qualification output")
        require(not host_output.exists(), "qualification output already exists")
        for relative, raw in data.items():
            control.write_bytes(operation["root"] + "/inputs/" + relative, raw)

        technical_log = str(CONTROL / operation["root"] / "runtime.log")
        result = {
            "schema": SCHEMA, "operation_attempt": token, "compose_project": control.project,
            "image_id": observed["Image"], "backend_container_id": backend_id,
            "reference_source_commit": args.source_commit, "reference_input_sha256": hashes,
            "package_commit": backend["commit"], "mounted_runtime_commit": mounted_commit,
            "mounted_non_runtime_changes": excluded, "package_source_snapshot_sha256": backend["snapshot"],
            "package_receipt_sha256": receipt_sha, "runtime_provenance_sha256": provenance_sha,
            "fullmag_binary_sha256": binary_sha, "runtime_log": technical_log,
            "output_root": str(host_output), "command": solver_arguments(token),
        }
        operation["receipt"]["scientific_execution"] = result
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        worker = (
            "import json,sys\n"
            "from docker_goebel_qualification import _run_worker\n"
            "try:\n"
            "    result = _run_worker(sys.argv[1], json.loads(sys.argv[2]), sys.argv[3], sys.argv[4] or None)\n"
            "except Exception as error:\n"
            "    result = {'worker_error': f'{type(error).__name__}: {error}'}\n"
            "print(json.dumps(result))"
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
                         canonical(hashes).decode(), binary_sha, args.terminal_run_id or ""),
            timeout=SOLVER_TIMEOUT_S + 300, stdout_limit=MAX_RECORD,
            environment={"PYTHONPATH": str(CONTROL / operation["root"] / "controller")
                         + ":/opt/fullmag/source/scripts"},
        )
        completed = codegen._read_json_bytes(stdout, "Göbel worker completion")
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
                0 if completed["verification"].get("state") == "passed" else 3)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo-root", type=Path, required=True)
    result.add_argument("--source-root", type=Path, required=True)
    result.add_argument("--attempt", required=True)
    result.add_argument("--config-sha256", required=True)
    result.add_argument("--source-commit", required=True)
    result.add_argument("--port", type=int, required=True)
    result.add_argument("--terminal-run-id")
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
