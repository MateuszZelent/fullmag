#!/usr/bin/env python3
"""Verify accepted-run FEM preparation through production processes.

The route builds the native FEM library and production API/CLI binaries from
one source identity, submits an immutable FEM RunSpec through public HTTP v2,
publishes a dedicated Meshing pool, and runs the accepted FEM preparation
scheduler.  It accepts success only when the exact task receipt, process
launch/exit proofs, released preparation lease, and public readiness projection
agree.  This is a process/runtime gate; it does not qualify solver physics.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as source_identity  # noqa: E402
from verify_project_api_runtime import (  # noqa: E402
    assert_build_identity,
    json_request,
    terminate_process,
    wait_for_health,
    write_atomic_json,
)
from verify_resource_discovery_runtime import (  # noqa: E402
    run_json_process,
    start_api,
)


RECEIPT_SCHEMA = "fullmag_accepted_fem_preparation_runtime_v1"
FIXTURE = "tests/fixtures/runtime/accepted-fem-preparation-run-v2.json"
BINARIES = (
    "fullmag-api",
    "fullmag-api-preparation-resource-pool",
    "fullmag-api-accepted-fem-preparer",
    "fullmag-api-accepted-fem-preparation-scheduler",
    "fullmag",
)


class AcceptedFemPreparationRuntimeError(RuntimeError):
    """The managed build, process, or durable preparation proof failed."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path, label: str) -> dict[str, object]:
    if path.is_symlink() or not path.is_file():
        raise AcceptedFemPreparationRuntimeError(f"{label} is missing or not a regular file: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AcceptedFemPreparationRuntimeError(f"{label} must contain one JSON object: {path}")
    return value


def load_fixture(repo_root: Path, invocation_id: str) -> tuple[dict[str, object], dict[str, object]]:
    path = (repo_root / FIXTURE).resolve()
    raw = path.read_bytes()
    request = json.loads(raw)
    run_id = f"accepted-fem-preparation-{invocation_id}"
    intent = request["run_intent"]
    specification = intent["specification"]
    intent["idempotency_key"] = f"accepted-fem-preparation-{invocation_id}"
    specification["run_id"] = run_id
    execution = specification["requested_execution"]
    problem = request["study_problem_catalog"]["entries"][0]["problem"]
    if (
        execution.get("backend") != "fem"
        or execution.get("device") != "cpu"
        or execution.get("mode") != "strict"
        or execution.get("precision") != "double"
        or problem.get("backend_policy", {}).get("requested_backend") != "fem"
    ):
        raise AcceptedFemPreparationRuntimeError("accepted FEM fixture does not request strict FEM CPU")
    return request, {
        "path": str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "run_id": run_id,
        "project_id": specification["snapshot"]["project_id"],
        "study_catalog_sha256": specification["study_catalog_sha256"],
        "study_plan_sha256": specification["study"]["plan_sha256"],
    }


def run_logged(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    timeout: int,
) -> None:
    with log_path.open("w", encoding="utf-8", newline="\n") as log:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
    if result.returncode != 0:
        raise AcceptedFemPreparationRuntimeError(
            f"process failed with code {result.returncode}; see {log_path}"
        )


def build_runtime(
    repo_root: Path,
    build_root: Path,
    run_root: Path,
    env: dict[str, str],
) -> tuple[dict[str, Path], dict[str, object], list[list[str]]]:
    native_root = build_root / "native"
    cargo_target = build_root / "cargo-target"
    native_root.mkdir(parents=True, exist_ok=True)
    cargo_target.mkdir(parents=True, exist_ok=True)
    env["CARGO_TARGET_DIR"] = str(cargo_target)
    env["CARGO_INCREMENTAL"] = "0"

    commands = [
        [
            "cmake", "-S", "native", "-B", str(native_root),
            "-DFULLMAG_ENABLE_CUDA=OFF",
            "-DFULLMAG_ENABLE_FEM_GPU=OFF",
            "-DFULLMAG_USE_MFEM_STACK=ON",
            "-DFULLMAG_FEM_WITH_SLEPC=OFF",
        ],
        ["cmake", "--build", str(native_root), "--target", "fullmag_fem"],
    ]
    run_logged(commands[0], cwd=repo_root, env=env, log_path=run_root / "cmake-configure.log", timeout=300)
    run_logged(commands[1], cwd=repo_root, env=env, log_path=run_root / "cmake-build.log", timeout=900)

    fem_lib = native_root / "backends" / "fem"
    env["FULLMAG_FEM_LIB_DIR"] = str(fem_lib)
    prior_library_path = env.get("LD_LIBRARY_PATH", "")
    env["LD_LIBRARY_PATH"] = str(fem_lib) + (os.pathsep + prior_library_path if prior_library_path else "")
    api_build = [
        "cargo", "build", "--locked", "--offline", "-p", "fullmag-api",
        "--features", "fem-native",
        "--bin", "fullmag-api",
        "--bin", "fullmag-api-preparation-resource-pool",
        "--bin", "fullmag-api-accepted-fem-preparer",
        "--bin", "fullmag-api-accepted-fem-preparation-scheduler",
    ]
    cli_build = [
        "cargo", "build", "--locked", "--offline", "-p", "fullmag-cli", "--bin", "fullmag",
    ]
    commands.extend((api_build, cli_build))
    run_logged(api_build, cwd=repo_root, env=env, log_path=run_root / "cargo-api.log", timeout=1200)
    run_logged(cli_build, cwd=repo_root, env=env, log_path=run_root / "cargo-cli.log", timeout=600)

    extension = ".exe" if os.name == "nt" else ""
    binaries: dict[str, Path] = {}
    evidence: dict[str, object] = {}
    for name in BINARIES:
        built = cargo_target / "debug" / f"{name}{extension}"
        if not built.is_file() or built.stat().st_size == 0:
            raise AcceptedFemPreparationRuntimeError(f"built binary is missing or empty: {built}")
        preserved = run_root / built.name
        shutil.copy2(built, preserved)
        binaries[name] = preserved
        evidence[name] = {
            "path": str(preserved),
            "size_bytes": preserved.stat().st_size,
            "sha256": sha256(preserved),
        }
    libraries = sorted(fem_lib.glob("*fullmag_fem*"))
    if not libraries:
        raise AcceptedFemPreparationRuntimeError("native FEM build produced no fullmag_fem library")
    evidence["native_fem"] = [
        {"path": str(path), "size_bytes": path.stat().st_size, "sha256": sha256(path)}
        for path in libraries
        if path.is_file()
    ]
    return binaries, evidence, commands


def one_json(path: Path, label: str) -> tuple[Path, dict[str, object]]:
    paths = sorted(path.glob("*.json")) if path.is_dir() else []
    if len(paths) != 1:
        raise AcceptedFemPreparationRuntimeError(f"{label} requires exactly one JSON document")
    return paths[0], load_json(paths[0], label)


def validate_durable_evidence(
    store_root: Path,
    run_id: str,
    task_id: str,
    resource_id: str,
) -> dict[str, object]:
    run_root = store_root / "runs" / run_id
    receipt_path = run_root / "task_preparation_receipts" / f"{task_id}.json"
    receipt = load_json(receipt_path, "task preparation receipt")
    launch_path, launch = one_json(run_root / "preparation_process_launches", "process launch")
    exit_path, process_exit = one_json(
        run_root / "preparation_process_exit_receipts", "process exit receipt"
    )
    lease_dir = run_root / "preparation_resource_leases" / resource_id
    lease_path, lease = one_json(lease_dir, "preparation resource lease")
    identities = ("run_id", "task_id", "preparation_attempt_id", "resource_id", "lease_token")
    for field in identities:
        expected = lease.get(field)
        if launch.get(field) != expected or process_exit.get(field) != expected:
            raise AcceptedFemPreparationRuntimeError(f"durable preparation identity mismatch for {field}")
    if (
        receipt.get("run_id") != run_id
        or receipt.get("task_id") != task_id
        or receipt.get("schema_version") != "task_preparation_receipt.v1"
        or lease.get("state") != "released"
        or lease.get("released_at") is None
        or process_exit.get("status_success") is not True
        or process_exit.get("exit_code") != 0
        or process_exit.get("timed_out") is not False
        or launch.get("schema_version") != "preparation_process_launch.v1"
        or process_exit.get("schema_version") != "preparation_process_exit_receipt.v1"
    ):
        raise AcceptedFemPreparationRuntimeError("durable preparation evidence is incomplete or unsuccessful")
    payload = receipt.get("payload")
    plan = payload.get("plan") if isinstance(payload, dict) else None
    if (
        not isinstance(plan, dict)
        or plan.get("schema_version") != "preparation_plan.v2"
        or plan.get("resolved_backend") != "fem"
        or plan.get("source", {}).get("kind") != "accepted_run_step"
    ):
        raise AcceptedFemPreparationRuntimeError("task receipt is not a FEM accepted-run preparation plan")
    certificates = payload.get("certificates")
    if not isinstance(certificates, list) or len(certificates) != 5:
        raise AcceptedFemPreparationRuntimeError("FEM preparation receipt must contain five certificates")
    return {
        "task_receipt": {"path": str(receipt_path), "sha256": sha256(receipt_path), "value": receipt},
        "process_launch": {"path": str(launch_path), "sha256": sha256(launch_path), "value": launch},
        "process_exit": {"path": str(exit_path), "sha256": sha256(exit_path), "value": process_exit},
        "resource_lease": {"path": str(lease_path), "sha256": sha256(lease_path), "value": lease},
    }


def run(repo_root: Path, build_root: Path, output_root: Path) -> tuple[int, dict[str, object]]:
    invocation_id = uuid.uuid4().hex
    run_root = output_root / invocation_id
    state_root = run_root / "state"
    runs_root = run_root / "runs"
    for path in (build_root, run_root, state_root, runs_root):
        path.mkdir(parents=True, exist_ok=True)
    receipt_path = run_root / "receipt.json"
    receipt: dict[str, object] = {
        "schema": RECEIPT_SCHEMA,
        "route": "api-accepted-fem-preparation-runtime",
        "invocation_id": invocation_id,
        "repo_root": str(repo_root),
        "started_at": utc_now(),
        "state": "preflight",
        "scope": [
            "public HTTP v2 immutable FEM RunSpec submission and materialization",
            "dedicated durable Meshing pool and lease",
            "production preparation scheduler, supervisor, and native FEM preparer process",
            "native mesh/space task receipt pinned to the accepted run",
            "durable process launch/exit reconciliation and exact lease release",
        ],
        "excluded_scope": ["solver execution", "scientific validation", "release qualification"],
    }
    write_atomic_json(receipt_path, receipt)
    api_process = None
    api_log = None
    exit_code = 2
    try:
        request, fixture = load_fixture(repo_root, invocation_id)
        request_path = run_root / "accepted-fem-request.json"
        write_atomic_json(request_path, request)
        receipt["fixture"] = fixture
        identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
        receipt["source_identity"] = identity
        env = {str(key): str(value) for key, value in os.environ.items()}
        env.update(
            {
                "FULLMAG_STATE_ROOT": str(state_root),
                "FULLMAG_RUNS_ROOT": str(runs_root),
                "FULLMAG_WORKTREE_ID": f"accepted-fem-preparation-{invocation_id[:12]}",
                "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
                "FULLMAG_SOURCE_WORKTREE_STATE": "dirty" if identity["source_snapshot_dirty"] else "clean",
                "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(identity["source_snapshot_sha256"]),
                "FULLMAG_DISABLE_STATIC_CONTROL_ROOM": "1",
                "CARGO_BUILD_JOBS": env.get("CARGO_BUILD_JOBS", "2"),
                "TMPDIR": str(run_root / "tmp"),
            }
        )
        Path(env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
        receipt["state"] = "building"
        write_atomic_json(receipt_path, receipt)
        binaries, binary_evidence, build_commands = build_runtime(
            repo_root, build_root, run_root, env
        )
        receipt["binaries"] = binary_evidence
        receipt["build_commands"] = build_commands

        receipt["state"] = "submitting"
        write_atomic_json(receipt_path, receipt)
        api_process, api_log, base_url = start_api(
            binaries["fullmag-api"], repo_root, env, run_root / "api-submit.log"
        )
        health = wait_for_health(base_url, api_process)
        _, openapi = json_request(f"{base_url}/v2/platform/openapi.json")
        build_identity = assert_build_identity(
            openapi,
            {
                "git_commit": identity["head_commit_full"],
                "source_snapshot_sha256": identity["source_snapshot_sha256"],
                "worktree_state": "dirty" if identity["source_snapshot_dirty"] else "clean",
            },
        )
        submitted = run_json_process(
            [str(binaries["fullmag"]), "run-json", str(request_path), "--api-url", base_url],
            cwd=repo_root,
            env=env,
            log_path=run_root / "cli-submit.log",
            timeout=90,
        )
        task_ids = submitted.get("materialization", {}).get("body", {}).get("task_ids", [])
        before = submitted.get("run", {}).get("body", {})
        tasks = before.get("tasks", [])
        if (
            submitted.get("run_id") != fixture["run_id"]
            or submitted.get("project_id") != fixture["project_id"]
            or submitted.get("submit", {}).get("status") != 201
            or len(task_ids) != 1
            or len(tasks) != 1
            or tasks[0].get("task_id") != task_ids[0]
            or tasks[0].get("lifecycle") != "accepted"
            or tasks[0].get("readiness", {}).get("reason") != "accepted_task_awaiting_preparation"
        ):
            raise AcceptedFemPreparationRuntimeError("public Submit did not materialize one FEM task awaiting preparation")
        task_id = str(task_ids[0])
        receipt["submit"] = {"health": health, "build_identity": build_identity, "result": submitted}
        receipt["api_submit_exit_code"] = terminate_process(api_process)
        api_process = None
        api_log.close()
        api_log = None

        store_root = runs_root / "session-store"
        pool_id = f"accepted-fem-preparation-{invocation_id}"
        resource_id = f"meshing-{invocation_id}"
        offer = json.dumps(
            {
                "resource_id": resource_id,
                "budget": {
                    "cpu_millis": 1000,
                    "memory_bytes": 536870912,
                    "gpu_memory_bytes": 0,
                    "storage_bytes": 536870912,
                },
            },
            separators=(",", ":"),
        )
        pool = run_json_process(
            [
                str(binaries["fullmag-api-preparation-resource-pool"]),
                "--store-root", str(store_root),
                "--pool-id", pool_id,
                "--expected-generation", "0",
                "--resource-offer", offer,
            ],
            cwd=repo_root,
            env=env,
            log_path=run_root / "preparation-resource-pool.log",
            timeout=30,
        )
        if pool.get("status") != "accepted" or pool.get("generation") != 1:
            raise AcceptedFemPreparationRuntimeError("Meshing resource pool publication failed")
        scheduler = run_json_process(
            [
                str(binaries["fullmag-api-accepted-fem-preparation-scheduler"]),
                "--store-root", str(store_root),
                "--pool-id", pool_id,
                "--preparer-executable", str(binaries["fullmag-api-accepted-fem-preparer"]),
                "--max-concurrency", "1",
                "--max-tasks", "1",
                "--process-timeout-seconds", "180",
                "--heartbeat-interval-milliseconds", "250",
            ],
            cwd=repo_root,
            env=env,
            log_path=run_root / "preparation-scheduler.log",
            timeout=240,
        )
        executed = scheduler.get("executed", [])
        if (
            scheduler.get("status") != "completed"
            or scheduler.get("scheduled_count") != 1
            or len(executed) != 1
            or executed[0].get("run_id") != fixture["run_id"]
            or executed[0].get("task_id") != task_id
            or executed[0].get("resource_id") != resource_id
            or executed[0].get("status_success") is not True
            or executed[0].get("timed_out") is not False
            or executed[0].get("finalization") not in {"completed", "replayed"}
        ):
            raise AcceptedFemPreparationRuntimeError("preparation scheduler did not complete the exact FEM task")
        receipt["resource_pool"] = pool
        receipt["scheduler"] = scheduler
        receipt["durable_evidence"] = validate_durable_evidence(
            store_root, str(fixture["run_id"]), task_id, resource_id
        )

        api_process, api_log, result_url = start_api(
            binaries["fullmag-api"], repo_root, env, run_root / "api-result.log"
        )
        wait_for_health(result_url, api_process)
        _, after = json_request(
            f"{result_url}/v2/persistence/projects/{fixture['project_id']}/runs/{fixture['run_id']}"
        )
        after_tasks = after.get("tasks", [])
        if (
            len(after_tasks) != 1
            or after_tasks[0].get("task_id") != task_id
            or after_tasks[0].get("lifecycle") != "accepted"
            or after_tasks[0].get("readiness", {}).get("reason")
            != "accepted_task_awaiting_dependency_resolution"
        ):
            raise AcceptedFemPreparationRuntimeError("public run projection did not advance to dependency resolution")
        receipt["after_preparation"] = after
        receipt["api_result_exit_code"] = terminate_process(api_process)
        api_process = None
        api_log.close()
        api_log = None

        after_identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
        receipt["source_identity_after"] = after_identity
        receipt["source_changed_during_run"] = (
            after_identity["source_snapshot_sha256"] != identity["source_snapshot_sha256"]
        )
        if receipt["source_changed_during_run"]:
            raise AcceptedFemPreparationRuntimeError("source identity changed during runtime verification")
        receipt["state"] = "passed"
        exit_code = 0
    except BaseException as error:
        receipt["state"] = "failed"
        receipt["error"] = f"{type(error).__name__}: {error}"
        exit_code = 1
    finally:
        if api_process is not None:
            receipt["api_cleanup_exit_code"] = terminate_process(api_process)
        if api_log is not None:
            api_log.close()
        receipt["finished_at"] = utc_now()
        receipt["exit_code"] = exit_code
        write_atomic_json(receipt_path, receipt)
    print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"], "error": receipt.get("error")}))
    return exit_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--build-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve(), args.build_root.resolve(), args.output_root.resolve())[0]
    except Exception as error:
        print(f"accepted FEM preparation runtime failed before receipt: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
