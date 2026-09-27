#!/usr/bin/env python3
"""Verify local resource discovery through the production accepted-run processes.

This managed Windows route builds the real API, resource-pool publisher,
scheduler, and worker binaries. It submits one immutable RunSpec v2 through
HTTP, publishes the discovered host capacity, executes exactly that run, and
requires the exact durable resource lease to be released.
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
import fullmag_storage as storage  # noqa: E402
from verify_project_api_runtime import (  # noqa: E402
    assert_build_identity,
    child_environment,
    free_loopback_port,
    json_request,
    terminate_process,
    wait_for_health,
    write_atomic_json,
)
from verify_session_persistence import toolchain_identity  # noqa: E402


PROFILE = "windows-project-api-runtime"
RECEIPT_SCHEMA = "fullmag_resource_discovery_runtime_v1"
FIXTURE = "tests/fixtures/runtime/resource-discovery-run-v2.json"
API_BINARY_NAMES = (
    "fullmag-api",
    "fullmag-api-resource-pool",
    "fullmag-api-accepted-scheduler",
    "fullmag-api-accepted-worker",
)
BINARY_NAMES = API_BINARY_NAMES + ("fullmag",)


class ResourceDiscoveryRuntimeError(RuntimeError):
    """A managed build, process, persistence, or runtime assertion failed."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def contained_paths(layout: dict[str, object], invocation_id: str) -> dict[str, Path]:
    build_storage = Path(str(layout["build_storage_root"]))
    run_root = storage.validate_path(
        Path(str(layout["build_root"])) / "resource-discovery-runtime" / invocation_id,
        build_storage,
        "resource discovery runtime root",
    )
    temp_root = storage.validate_path(
        Path(str(layout["temp_root"])) / "resource-discovery-runtime" / invocation_id,
        build_storage,
        "resource discovery temporary root",
    )
    return {
        "run_root": run_root,
        "temp_root": temp_root,
        "state_root": storage.validate_path(run_root / "state", build_storage, "API state root"),
        "target_dir": storage.validate_path(
            Path(str(layout["build_root"])) / "cargo-target",
            build_storage,
            "resource discovery cargo target",
        ),
        "cargo_home": storage.validate_path(
            Path(str(layout["cache_root"])) / "cargo",
            Path(str(layout["cache_root"])),
            "resource discovery Cargo home",
        ),
        "rustup_home": storage.validate_path(
            Path(str(layout["cache_root"])) / "rustup",
            Path(str(layout["cache_root"])),
            "resource discovery Rustup home",
        ),
        "receipt": run_root / "receipt.json",
        "source_before": run_root / "source-snapshot.v2.json",
        "source_after": run_root / "source-snapshot-after.v2.json",
        "cargo_log": run_root / "cargo.log",
        "api_submit_log": run_root / "api-submit.log",
        "cli_submit_log": run_root / "cli-submit.log",
        "runtime_request": run_root / "accepted-run-request.json",
        "publisher_log": run_root / "resource-pool.log",
        "scheduler_log": run_root / "scheduler.log",
        "api_result_log": run_root / "api-result.log",
    }


def load_fixture(repo_root: Path) -> tuple[dict[str, object], dict[str, object]]:
    path = (repo_root / FIXTURE).resolve()
    if not path.is_file():
        raise ResourceDiscoveryRuntimeError(f"runtime fixture is missing: {path}")
    raw = path.read_bytes()
    payload = json.loads(raw)
    identity = uuid.uuid4().hex
    run_id = f"000-runtime-{identity}"
    intent = payload["run_intent"]
    intent["idempotency_key"] = f"resource-discovery-{identity}"
    intent["specification"]["run_id"] = run_id
    return payload, {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "run_id": run_id}


def existing_run_ids(store_root: Path) -> list[str]:
    runs = store_root / "runs"
    if not runs.is_dir():
        return []
    return sorted(path.name for path in runs.iterdir() if path.is_dir())


def run_json_process(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    timeout: int,
) -> dict[str, object]:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    log_path.write_text(
        f"$ {' '.join(command)}\nexit_code={result.returncode}\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}",
        encoding="utf-8",
    )
    if result.returncode != 0:
        raise ResourceDiscoveryRuntimeError(
            f"process failed with code {result.returncode}; see {log_path}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ResourceDiscoveryRuntimeError(
            f"process did not emit one JSON result; see {log_path}"
        ) from error
    if not isinstance(payload, dict):
        raise ResourceDiscoveryRuntimeError(f"process JSON is not an object; see {log_path}")
    return payload


def start_api(
    binary: Path,
    repo_root: Path,
    env: dict[str, str],
    log_path: Path,
) -> tuple[subprocess.Popen[bytes], object, str]:
    port = free_loopback_port()
    api_env = dict(env)
    api_env["FULLMAG_API_PORT"] = str(port)
    log = log_path.open("w", encoding="utf-8", newline="\n")
    process = subprocess.Popen(
        [str(binary)],
        cwd=repo_root,
        env=api_env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    return process, log, f"http://127.0.0.1:{port}"


def validate_publisher(payload: dict[str, object], run_minimum: dict[str, int]) -> dict[str, object]:
    if payload.get("status") != "accepted" or payload.get("generation") != 1:
        raise ResourceDiscoveryRuntimeError("resource pool publication was not accepted at generation 1")
    discovery = payload.get("discovery")
    resources = payload.get("resources")
    if not isinstance(discovery, dict) or not isinstance(resources, list):
        raise ResourceDiscoveryRuntimeError("resource publisher omitted discovery evidence")
    if discovery.get("allocation_policy") != "equal_shared_capacity_partition":
        raise ResourceDiscoveryRuntimeError("resource publisher used an unexpected allocation policy")
    cpu = next((item for item in resources if isinstance(item, dict) and item.get("kind") == "cpu"), None)
    if not isinstance(cpu, dict) or not str(cpu.get("resource_id", "")).endswith(".cpu"):
        raise ResourceDiscoveryRuntimeError("local discovery did not publish a stable CPU offer")
    budget = cpu.get("budget")
    if not isinstance(budget, dict):
        raise ResourceDiscoveryRuntimeError("discovered CPU offer omitted its resource budget")
    for key in ("cpu_millis", "memory_bytes", "storage_bytes"):
        if int(budget.get(key, -1)) < int(run_minimum[key]):
            raise ResourceDiscoveryRuntimeError(f"discovered CPU offer does not satisfy {key}")
    if int(budget.get("gpu_memory_bytes", -1)) != 0:
        raise ResourceDiscoveryRuntimeError("CPU offer must expose zero GPU memory")
    return cpu


def durable_leases(store_root: Path, run_id: str) -> list[dict[str, object]]:
    lease_root = store_root / "runs" / run_id / "resource_leases"
    if not lease_root.is_dir():
        raise ResourceDiscoveryRuntimeError("scheduler produced no durable resource lease directory")
    leases = []
    for path in sorted(lease_root.glob("*/*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["path"] = str(path)
        payload["sha256"] = sha256(path)
        leases.append(payload)
    if not leases:
        raise ResourceDiscoveryRuntimeError("scheduler produced no durable resource lease")
    return leases


def run(repo_root: Path) -> tuple[int, dict[str, object]]:
    if os.name != "nt":
        raise ResourceDiscoveryRuntimeError("managed resource discovery runtime is Windows-only")
    layout = storage.resolve_layout(repo_root, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        invocation_id = uuid.uuid4().hex
        paths = contained_paths(layout, invocation_id)
        for key in ("run_root", "temp_root", "state_root", "target_dir", "cargo_home", "rustup_home"):
            paths[key].mkdir(parents=True, exist_ok=True)
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "route": "api-resource-discovery-runtime",
            "profile": PROFILE,
            "invocation_id": invocation_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": layout["repo_root"],
            "started_at": utc_now(),
            "state": "preflight",
            "paths": {key: str(value) for key, value in paths.items()},
            "runtime_scope": [
                "fullmag submit-run-json through public HTTP v2 for one immutable RunSpec v2",
                "local CPU/RAM/storage and optional NVIDIA GPU discovery",
                "durable resource-pool publication and scheduler admission",
                "production accepted worker process and exact lease release",
            ],
        }
        write_atomic_json(paths["receipt"], receipt)
        api_process: subprocess.Popen[bytes] | None = None
        api_log = None
        result_code = 2
        try:
            fixture, fixture_evidence = load_fixture(repo_root)
            receipt["fixture"] = fixture_evidence
            write_atomic_json(paths["runtime_request"], fixture)
            run_id = str(fixture_evidence["run_id"])
            project_id = str(fixture["run_intent"]["specification"]["snapshot"]["project_id"])
            run_minimum = fixture["run_intent"]["specification"]["requested_execution"]["minimum_resources"]
            identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_before"], identity)
            receipt["source_identity"] = identity
            toolchain, tools = toolchain_identity()
            receipt["toolchain"] = toolchain
            env = child_environment(layout, paths, tools, PROFILE)
            env.update(
                {
                    "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
                    "FULLMAG_SOURCE_WORKTREE_STATE": "dirty" if identity["source_snapshot_dirty"] else "clean",
                    "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(identity["source_snapshot_sha256"]),
                    "FULLMAG_DISABLE_STATIC_CONTROL_ROOM": "1",
                }
            )
            store_root = Path(env["FULLMAG_RUNS_ROOT"]) / "session-store"
            prior_runs = existing_run_ids(store_root)
            receipt["shared_store_guard"] = {
                "store_root": str(store_root),
                "prior_run_count": len(prior_runs),
                "run_source": "explicit",
                "run_id": run_id,
                "max_tasks": 1,
            }

            cargo = str(tools["cargo"])
            build_command = [
                cargo,
                "build",
                "--locked",
                "--offline",
                "-p",
                "fullmag-api",
                "-p",
                "fullmag-cli",
            ]
            for name in BINARY_NAMES:
                build_command.extend(["--bin", name])
            receipt["build_command"] = build_command
            receipt["state"] = "building"
            write_atomic_json(paths["receipt"], receipt)
            with paths["cargo_log"].open("w", encoding="utf-8", newline="\n") as cargo_log:
                build = subprocess.run(
                    build_command,
                    cwd=repo_root,
                    env=env,
                    stdout=cargo_log,
                    stderr=subprocess.STDOUT,
                    text=True,
                    check=False,
                )
            receipt["build_exit_code"] = build.returncode
            if build.returncode != 0:
                raise ResourceDiscoveryRuntimeError(f"production binary build failed with code {build.returncode}")

            extension = ".exe" if os.name == "nt" else ""
            binaries: dict[str, Path] = {}
            binary_evidence: dict[str, object] = {}
            for name in BINARY_NAMES:
                built = paths["target_dir"] / "debug" / f"{name}{extension}"
                if not built.is_file() or built.stat().st_size == 0:
                    raise ResourceDiscoveryRuntimeError(f"built binary is missing or empty: {built}")
                preserved = paths["run_root"] / built.name
                shutil.copy2(built, preserved)
                binaries[name] = preserved
                binary_evidence[name] = {
                    "path": str(preserved),
                    "size_bytes": preserved.stat().st_size,
                    "sha256": sha256(preserved),
                }
            receipt["binaries"] = binary_evidence

            receipt["state"] = "submitting"
            write_atomic_json(paths["receipt"], receipt)
            api_process, api_log, base_url = start_api(
                binaries["fullmag-api"], repo_root, env, paths["api_submit_log"]
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
            cli_command = [
                str(binaries["fullmag"]),
                "submit-run-json",
                str(paths["runtime_request"]),
                "--api-url",
                base_url,
            ]
            cli_submit = run_json_process(
                cli_command,
                cwd=repo_root,
                env=env,
                log_path=paths["cli_submit_log"],
                timeout=45,
            )
            if (
                cli_submit.get("operation") != "submit_accepted_run"
                or cli_submit.get("transport") != "public_http_v2"
                or cli_submit.get("project_id") != project_id
                or cli_submit.get("run_id") != run_id
            ):
                raise ResourceDiscoveryRuntimeError("CLI accepted-run transport identity mismatch")
            submit_status = cli_submit.get("submit", {}).get("status")
            submitted = cli_submit.get("submit", {}).get("body", {})
            if submit_status != 201 or submitted.get("disposition") != "accepted" or submitted.get("run_id") != run_id:
                raise ResourceDiscoveryRuntimeError("CLI Submit did not accept the expected immutable run")
            materialized = cli_submit.get("materialization", {}).get("body", {})
            before = cli_submit.get("run", {}).get("body", {})
            tasks = before.get("tasks", [])
            if (
                materialized.get("execution_state") != "pending_preparation"
                or before.get("catalog_state") != "materialized"
                or len(tasks) != 1
                or tasks[0].get("lifecycle") != "accepted"
                or tasks[0].get("readiness", {}).get("state") != "blocked"
            ):
                raise ResourceDiscoveryRuntimeError("materialized run did not expose one blocked accepted task")
            receipt["submit"] = {
                "health": health,
                "build_identity": build_identity,
                "cli": cli_submit,
            }
            receipt["api_submit_exit_code"] = terminate_process(api_process)
            api_process = None
            api_log.close()
            api_log = None

            host_id = f"runtime-{invocation_id[:20]}"
            pool_id = f"resource-discovery-{invocation_id}"
            publisher_command = [
                str(binaries["fullmag-api-resource-pool"]),
                "--store-root", str(store_root),
                "--pool-id", pool_id,
                "--expected-generation", "0",
                "--discover-local", "true",
                "--host-resource-id", host_id,
                "--include-cpu", "true",
                "--require-gpu", "false",
                "--cpu-reserve-millis", "1000",
                "--memory-reserve-bytes", "536870912",
                "--storage-reserve-bytes", "536870912",
            ]
            published = run_json_process(
                publisher_command, cwd=repo_root, env=env, log_path=paths["publisher_log"], timeout=30
            )
            cpu_offer = validate_publisher(published, run_minimum)
            receipt["resource_pool"] = published

            receipt["state"] = "scheduling"
            write_atomic_json(paths["receipt"], receipt)
            scheduler_command = [
                str(binaries["fullmag-api-accepted-scheduler"]),
                "--store-root", str(store_root),
                "--run-id", run_id,
                "--pool-id", pool_id,
                "--resident", "true",
                "--discover-resources", "true",
                "--worker-executable", str(binaries["fullmag-api-accepted-worker"]),
                "--max-concurrency", "1",
                "--max-tasks", "1",
                "--max-idle-polls", "0",
                "--idle-poll-milliseconds", "20",
                "--worker-timeout-seconds", "60",
                "--heartbeat-interval-milliseconds", "250",
                "--max-automatic-retries", "0",
            ]
            scheduler = run_json_process(
                scheduler_command, cwd=repo_root, env=env, log_path=paths["scheduler_log"], timeout=120
            )
            executed = scheduler.get("executed")
            if (
                scheduler.get("status") != "completed"
                or scheduler.get("scheduled_count") != 1
                or scheduler.get("run_source") != "explicit"
                or scheduler.get("resource_source") != "store"
                or scheduler.get("resource_pool_generation") != 1
                or not isinstance(executed, list)
                or len(executed) != 1
                or executed[0].get("run_id") != run_id
                or executed[0].get("resource_id") != cpu_offer["resource_id"]
                or executed[0].get("worker", {}).get("status") != "completed"
            ):
                raise ResourceDiscoveryRuntimeError("scheduler did not execute the submitted run on the discovered CPU offer")
            receipt["scheduler"] = scheduler

            leases = durable_leases(store_root, run_id)
            if any(
                lease.get("state") != "released"
                or lease.get("released_at") is None
                or lease.get("resource_id") != cpu_offer["resource_id"]
                for lease in leases
            ):
                raise ResourceDiscoveryRuntimeError("the exact discovered resource lease was not durably released")
            receipt["resource_leases"] = leases

            api_process, api_log, result_url = start_api(
                binaries["fullmag-api"], repo_root, env, paths["api_result_log"]
            )
            wait_for_health(result_url, api_process)
            _, after = json_request(
                f"{result_url}/v2/persistence/projects/{project_id}/runs/{run_id}"
            )
            after_tasks = after.get("tasks", [])
            if len(after_tasks) != 1 or after_tasks[0].get("lifecycle") != "succeeded":
                raise ResourceDiscoveryRuntimeError("public run projection did not expose terminal success")
            if after.get("requested_execution", {}).get("minimum_resources") != run_minimum:
                raise ResourceDiscoveryRuntimeError("public run projection lost immutable resource minima")
            receipt["after_scheduler"] = after
            receipt["api_result_exit_code"] = terminate_process(api_process)
            api_process = None
            api_log.close()
            api_log = None

            identity_after = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_after"], identity_after)
            receipt["source_identity_after"] = identity_after
            receipt["source_changed_during_run"] = (
                identity_after["source_snapshot_sha256"] != identity["source_snapshot_sha256"]
            )
            if receipt["source_changed_during_run"]:
                raise ResourceDiscoveryRuntimeError("source identity changed during runtime verification")
            receipt["state"] = "passed"
            result_code = 0
        except BaseException as error:
            receipt["state"] = "failed"
            receipt["error"] = f"{type(error).__name__}: {error}"
            result_code = 1
        finally:
            if api_process is not None:
                receipt["api_cleanup_exit_code"] = terminate_process(api_process)
            if api_log is not None:
                api_log.close()
            receipt["finished_at"] = utc_now()
            receipt["exit_code"] = result_code
            write_atomic_json(paths["receipt"], receipt)
        print(
            json.dumps(
                {"receipt": str(paths["receipt"]), "state": receipt["state"], "error": receipt.get("error")},
                ensure_ascii=False,
            )
        )
        return result_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve())[0]
    except Exception as error:
        print(
            f"resource discovery runtime failed before receipt: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
