#!/usr/bin/env python3
"""Verify local resource discovery through the production accepted-run processes.

This managed Windows route builds the real CLI, API, resource-pool publisher,
scheduler, and worker binaries. It submits six immutable RunSpec v2 payloads
through HTTP, proves atomic public Submit backpressure and replay, proves
strict immutable priority with a bounded queue window, publishes discovered
host capacity, executes the highest-priority runs, and requires each exact
durable resource lease to be released after worker-originated control ACKs.
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
import time
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
RECEIPT_SCHEMA = "fullmag_resource_discovery_runtime_v4"
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
        "publisher_log": run_root / "resource-pool.log",
        "scheduler_log": run_root / "scheduler.log",
        "scheduler_cancel_log": run_root / "scheduler-cancel.log",
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
    return payload, {
        "path": str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "identity": identity,
        "run_id": run_id,
    }


def prioritized_requests(
    fixture: dict[str, object], identity: str
) -> list[tuple[str, str, int, dict[str, object]]]:
    requests = []
    for label, prefix, priority in (
        ("high", "000", 10),
        ("normal-a", "100", 0),
        ("normal-b", "110", 0),
        ("normal-c", "120", 0),
        ("low", "200", -10),
        ("unmaterialized", "900", 100),
    ):
        request = json.loads(json.dumps(fixture))
        run_id = f"{prefix}-runtime-{identity}"
        intent = request["run_intent"]
        intent["idempotency_key"] = f"resource-discovery-{label}-{identity}"
        intent["specification"]["run_id"] = run_id
        intent["specification"]["scheduling_priority"] = priority
        requests.append((label, run_id, priority, request))
    return requests


def overload_request(
    fixture: dict[str, object], identity: str
) -> tuple[str, str, int, dict[str, object]]:
    request = json.loads(json.dumps(fixture))
    run_id = f"950-runtime-{identity}"
    intent = request["run_intent"]
    intent["idempotency_key"] = f"resource-discovery-overload-{identity}"
    intent["specification"]["run_id"] = run_id
    intent["specification"]["scheduling_priority"] = 1000
    return "overload", run_id, 1000, request


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


def run_worker_cancellation_scenario(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    base_url: str,
    project_id: str,
    run_id: str,
    task_id: str,
) -> dict[str, object]:
    cancel_env = dict(env)
    cancel_env["FULLMAG_ENABLE_TEST_HOOKS"] = "1"
    cancel_env["FULLMAG_TEST_ACCEPTED_WORKER_AFTER_STARTED_DELAY_MS"] = "30000"
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=cancel_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout = ""
    stderr = ""
    try:
        deadline = time.monotonic() + 30.0
        observed = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            _, observed = json_request(
                f"{base_url}/v2/persistence/projects/{project_id}/runs/{run_id}"
            )
            tasks = observed.get("tasks", []) if isinstance(observed, dict) else []
            lifecycle = tasks[0].get("lifecycle") if len(tasks) == 1 else None
            if lifecycle == "running":
                break
            if lifecycle in {"succeeded", "failed", "cancelled", "interrupted"}:
                raise ResourceDiscoveryRuntimeError(
                    f"cancellation worker became terminal before Stop: {lifecycle}"
                )
            time.sleep(0.05)
        else:
            raise ResourceDiscoveryRuntimeError(
                "cancellation worker did not publish Started before the deadline"
            )
        if process.poll() is not None:
            raise ResourceDiscoveryRuntimeError(
                "cancellation scheduler exited before the worker published Started"
            )
        cancellation_url = (
            f"{base_url}/v2/persistence/projects/{project_id}/runs/{run_id}"
            f"/tasks/{task_id}/cancellation"
        )
        cancellation_deadline = time.monotonic() + 20.0
        while True:
            cancellation_status, cancellation = json_request(
                cancellation_url,
                method="POST",
                payload={"reason": "managed worker Stop acknowledgement proof"},
                expected_error=409,
            )
            if cancellation_status in {200, 202}:
                break
            if (
                cancellation_status != 409
                or not isinstance(cancellation, dict)
                or cancellation.get("code") != "run_store_busy"
                or time.monotonic() >= cancellation_deadline
            ):
                raise ResourceDiscoveryRuntimeError(
                    "public cancellation hit a non-retryable storage conflict: "
                    f"status={cancellation_status} body={cancellation}"
                )
            time.sleep(0.02)
        if (
            cancellation_status not in {200, 202}
            or not isinstance(cancellation, dict)
            or cancellation.get("disposition") not in {"accepted", "replayed"}
            or cancellation.get("lifecycle") != "stopping"
        ):
            raise ResourceDiscoveryRuntimeError(
                "public cancellation did not durably accept the Stop command"
            )
        stdout, stderr = process.communicate(timeout=60)
        if process.returncode != 0:
            raise ResourceDiscoveryRuntimeError(
                f"cancellation scheduler failed with code {process.returncode}"
            )
        try:
            scheduler = json.loads(stdout)
        except json.JSONDecodeError as error:
            raise ResourceDiscoveryRuntimeError(
                "cancellation scheduler did not emit one JSON result"
            ) from error
        executed = scheduler.get("executed", []) if isinstance(scheduler, dict) else []
        if (
            scheduler.get("status") != "completed"
            or scheduler.get("scheduled_count") != 1
            or len(executed) != 1
            or executed[0].get("run_id") != run_id
            or executed[0].get("worker_cancelled") is not True
            or executed[0].get("worker", {}).get("status") != "cancelled"
        ):
            raise ResourceDiscoveryRuntimeError(
                "scheduler did not report one worker-acknowledged cancellation"
            )
        return {
            "request": cancellation,
            "scheduler": scheduler,
        }
    finally:
        if process.poll() is None:
            try:
                process.terminate()
                tail_out, tail_err = process.communicate(timeout=5)
                stdout += tail_out
                stderr += tail_err
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    stderr += "\ncleanup could not reap cancellation scheduler"
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()
            except OSError as cleanup_error:
                stderr += f"\ncancellation scheduler cleanup failed: {cleanup_error}"
        log_path.write_text(
            f"$ {' '.join(command)}\nexit_code={process.returncode}\n"
            f"--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
            encoding="utf-8",
        )


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


def worker_control_evidence(
    store_root: Path,
    run_id: str,
    lease: dict[str, object],
    *,
    expected_terminal: str = "completed",
) -> dict[str, object]:
    run_root = store_root / "runs" / run_id
    journal_root = run_root / "coordinator_journal"
    entries = []
    for direction in ("command", "event"):
        direction_root = journal_root / direction
        if not direction_root.is_dir():
            raise ResourceDiscoveryRuntimeError(
                f"worker control journal has no {direction} stream for {run_id}"
            )
        for path in sorted(direction_root.glob("*.json")):
            entry = json.loads(path.read_text(encoding="utf-8"))
            message = entry.get("payload", {}).get("message", {})
            envelope = message.get("envelope", {})
            checkpoint = entry.get("payload", {}).get("checkpoint", {})
            if (
                entry.get("direction") != direction
                or message.get("direction") != direction
                or envelope.get("schema_version") != "worker_protocol.v3"
                or entry.get("run_id") != run_id
                or entry.get("attempt_id") != lease.get("attempt_id")
                or entry.get("lease_token") != lease.get("lease_token")
                or envelope.get("sequence") != entry.get("sequence")
            ):
                raise ResourceDiscoveryRuntimeError(
                    f"worker control journal identity mismatch for {run_id}"
                )
            entries.append(
                {
                    "direction": direction,
                    "sequence": int(entry["sequence"]),
                    "checkpoint": (
                        int(checkpoint.get("command_sequence", -1)),
                        int(checkpoint.get("event_sequence", -1)),
                    ),
                    "payload": envelope.get(direction, {}),
                }
            )
    entries.sort(key=lambda entry: sum(entry["checkpoint"]))
    watermark = (0, 0)
    for entry in entries:
        expected = (
            (watermark[0] + 1, watermark[1])
            if entry["direction"] == "command"
            else (watermark[0], watermark[1] + 1)
        )
        if entry["checkpoint"] != expected or entry["sequence"] != expected[
            0 if entry["direction"] == "command" else 1
        ]:
            raise ResourceDiscoveryRuntimeError(
                f"worker control journal is not one atomic combined prefix for {run_id}"
            )
        watermark = expected

    commands = sorted(
        (entry for entry in entries if entry["direction"] == "command"),
        key=lambda entry: entry["sequence"],
    )
    events = sorted(
        (entry for entry in entries if entry["direction"] == "event"),
        key=lambda entry: entry["sequence"],
    )
    heartbeat_sequences = [
        int(entry["payload"]["lease_heartbeat_sequence"])
        for entry in commands
        if entry["payload"].get("kind") == "heartbeat"
    ]
    acknowledged_sequences = [
        int(entry["payload"]["lease_heartbeat_sequence"])
        for entry in events
        if entry["payload"].get("kind") == "heartbeat_ack"
    ]
    event_kinds = [str(entry["payload"].get("kind")) for entry in events]
    command_kinds = [str(entry["payload"].get("kind")) for entry in commands]
    if heartbeat_sequences != acknowledged_sequences or (
        expected_terminal == "completed" and not heartbeat_sequences
    ):
        raise ResourceDiscoveryRuntimeError(
            f"worker heartbeat commands do not have exact worker ACKs for {run_id}"
        )
    if expected_terminal == "completed":
        if (
            event_kinds.count("completing") != 1
            or event_kinds.count("completed") != 1
            or event_kinds.index("completing") >= event_kinds.index("completed")
            or "stop" in command_kinds
            or "stopped" in event_kinds
        ):
            raise ResourceDiscoveryRuntimeError(
                f"worker completion quiescence barrier is missing or misordered for {run_id}"
            )
    elif expected_terminal == "stopped":
        if (
            command_kinds.count("stop") != 1
            or event_kinds.count("stopped") != 1
            or "completing" in event_kinds
            or "completed" in event_kinds
        ):
            raise ResourceDiscoveryRuntimeError(
                f"worker Stop command does not have one worker Stopped event for {run_id}"
            )
    else:
        raise ResourceDiscoveryRuntimeError(
            f"unsupported worker control terminal expectation: {expected_terminal}"
        )
    if lease.get("heartbeat_sequence") != acknowledged_sequences[-1]:
        raise ResourceDiscoveryRuntimeError(
            f"released lease does not carry the final worker ACK for {run_id}"
        )

    inbox_paths = sorted((run_root / "worker_inbox").glob("*.json"))
    if len(inbox_paths) != 1:
        raise ResourceDiscoveryRuntimeError(
            f"worker control proof requires one durable inbox for {run_id}"
        )
    inbox = json.loads(inbox_paths[0].read_text(encoding="utf-8")).get("payload", {})
    applied_heartbeats = [
        int(envelope["command"]["lease_heartbeat_sequence"])
        for envelope in inbox.get("applied", [])
        if envelope.get("command", {}).get("kind") == "heartbeat"
    ]
    if inbox.get("pending") is not None or applied_heartbeats != heartbeat_sequences:
        raise ResourceDiscoveryRuntimeError(
            f"durable worker inbox did not apply every heartbeat for {run_id}"
        )
    applied_kinds = [
        str(envelope.get("command", {}).get("kind"))
        for envelope in inbox.get("applied", [])
    ]
    if expected_terminal == "stopped" and applied_kinds.count("stop") != 1:
        raise ResourceDiscoveryRuntimeError(
            f"durable worker inbox did not apply the Stop command for {run_id}"
        )
    process_exit_paths = sorted((run_root / "worker_process_exit_receipts").glob("*.json"))
    if len(process_exit_paths) != 1:
        raise ResourceDiscoveryRuntimeError(
            f"worker control proof requires one process-exit receipt for {run_id}"
        )
    process_exit = json.loads(process_exit_paths[0].read_text(encoding="utf-8"))
    expected_stop_requested = expected_terminal == "stopped"
    if (
        process_exit.get("status_success") is not True
        or process_exit.get("stop_requested") is not expected_stop_requested
    ):
        raise ResourceDiscoveryRuntimeError(
            f"worker process-exit receipt does not match {expected_terminal} for {run_id}"
        )
    return {
        "protocol_schema": "worker_protocol.v3",
        "combined_checkpoint": {
            "command_sequence": watermark[0],
            "event_sequence": watermark[1],
        },
        "heartbeat_sequences": heartbeat_sequences,
        "acknowledged_sequences": acknowledged_sequences,
        "event_kinds": event_kinds,
        "command_kinds": command_kinds,
        "inbox_pending": False,
        "process_exit": {
            "status_success": process_exit["status_success"],
            "stop_requested": process_exit["stop_requested"],
            "timed_out": process_exit["timed_out"],
        },
        "lease_heartbeat_sequence": lease["heartbeat_sequence"],
        "lease_state": lease["state"],
    }


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
                "fullmag run-json through public HTTP v2 for six immutable RunSpec v2 payloads",
                "atomic six-run public Submit backlog limit, 429 rejection, and replay while full",
                "strict immutable scheduling priority and a bounded two-run queue window",
                "local CPU/RAM/storage and optional NVIDIA GPU discovery",
                "durable resource-pool publication and scheduler admission",
                "production accepted worker process and exact lease release",
                "worker-originated HeartbeatAck and completion quiescence barrier",
            ],
        }
        write_atomic_json(paths["receipt"], receipt)
        api_process: subprocess.Popen[bytes] | None = None
        api_log = None
        result_code = 2
        try:
            fixture, fixture_evidence = load_fixture(repo_root)
            receipt["fixture"] = fixture_evidence
            requests = prioritized_requests(fixture, str(fixture_evidence["identity"]))
            overload = overload_request(fixture, str(fixture_evidence["identity"]))
            for label, _, _, request in requests:
                write_atomic_json(paths["run_root"] / f"accepted-run-request-{label}.json", request)
            write_atomic_json(
                paths["run_root"] / "accepted-run-request-overload.json", overload[3]
            )
            project_id = str(fixture["run_intent"]["specification"]["snapshot"]["project_id"])
            run_minimum = fixture["run_intent"]["specification"]["requested_execution"]["minimum_resources"]
            identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_before"], identity)
            receipt["source_identity"] = identity
            toolchain, tools = toolchain_identity()
            receipt["toolchain"] = toolchain
            env = child_environment(layout, paths, tools, PROFILE)
            runtime_worktree_id = f"{layout['worktree_id']}-verify-{invocation_id[:12]}"
            runtime_runs_root = storage.validate_path(
                Path(env["FULLMAG_PROJECT_STORAGE_ROOT"]) / "runs" / runtime_worktree_id,
                Path(env["FULLMAG_PROJECT_STORAGE_ROOT"]),
                "isolated resource discovery runs root",
            )
            runtime_runs_root.mkdir(parents=True, exist_ok=True)
            env.update(
                {
                    "FULLMAG_WORKTREE_ID": runtime_worktree_id,
                    "FULLMAG_RUNS_ROOT": str(runtime_runs_root),
                    "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
                    "FULLMAG_SOURCE_WORKTREE_STATE": "dirty" if identity["source_snapshot_dirty"] else "clean",
                    "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(identity["source_snapshot_sha256"]),
                    "FULLMAG_DISABLE_STATIC_CONTROL_ROOM": "1",
                    "FULLMAG_ACCEPTED_RUN_BACKLOG_LIMIT": "6",
                }
            )
            store_root = Path(env["FULLMAG_RUNS_ROOT"]) / "session-store"
            prior_runs = existing_run_ids(store_root)
            receipt["shared_store_guard"] = {
                "store_root": str(store_root),
                "prior_run_count": len(prior_runs),
                "run_source": "store",
                "run_ids": [request[1] for request in requests],
                "overload_run_id": overload[1],
                "submit_backlog_limit": 6,
                "max_queued_runs": 2,
                "max_tasks": 4,
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
            cli_submits = []
            for label, expected_run_id, priority, _ in requests:
                request_path = paths["run_root"] / f"accepted-run-request-{label}.json"
                cli_command = [
                    str(binaries["fullmag"]),
                    "run-json",
                    str(request_path),
                    "--api-url",
                    base_url,
                ]
                if label == "unmaterialized":
                    cli_command.append("--submit-only")
                cli_submit = run_json_process(
                    cli_command,
                    cwd=repo_root,
                    env=env,
                    log_path=paths["run_root"] / f"cli-submit-{label}.log",
                    timeout=45,
                )
                if (
                    cli_submit.get("operation") != "submit_accepted_run"
                    or cli_submit.get("transport") != "public_http_v2"
                    or cli_submit.get("project_id") != project_id
                    or cli_submit.get("run_id") != expected_run_id
                ):
                    raise ResourceDiscoveryRuntimeError("CLI accepted-run transport identity mismatch")
                submit_status = cli_submit.get("submit", {}).get("status")
                submitted = cli_submit.get("submit", {}).get("body", {})
                if (
                    submit_status != 201
                    or submitted.get("disposition") != "accepted"
                    or submitted.get("run_id") != expected_run_id
                ):
                    raise ResourceDiscoveryRuntimeError("CLI Submit did not accept the expected immutable run")
                if label == "unmaterialized":
                    if cli_submit.get("materialization") is not None or cli_submit.get("run") is not None:
                        raise ResourceDiscoveryRuntimeError(
                            "submit-only run unexpectedly materialized a task catalog"
                        )
                    cli_submits.append(cli_submit)
                    continue
                materialized = cli_submit.get("materialization", {}).get("body", {})
                before = cli_submit.get("run", {}).get("body", {})
                tasks = before.get("tasks", [])
                if (
                    materialized.get("execution_state") != "pending_preparation"
                    or before.get("catalog_state") != "materialized"
                    or before.get("scheduling_priority") != priority
                    or len(tasks) != 1
                    or tasks[0].get("lifecycle") != "accepted"
                    or tasks[0].get("readiness", {}).get("state") != "blocked"
                ):
                    raise ResourceDiscoveryRuntimeError(
                        "materialized run did not preserve priority and one blocked accepted task"
                    )
                cli_submits.append(cli_submit)
            runs_url = f"{base_url}/v2/persistence/projects/{project_id}/runs"
            replay_status, replay_body = json_request(
                runs_url, method="POST", payload=requests[0][3]
            )
            if (
                replay_status != 200
                or not isinstance(replay_body, dict)
                or replay_body.get("disposition") != "replayed"
                or replay_body.get("run_id") != requests[0][1]
            ):
                raise ResourceDiscoveryRuntimeError(
                    "idempotent Submit replay was not accepted while the backlog was full"
                )
            overload_status, overload_body = json_request(
                runs_url,
                method="POST",
                payload=overload[3],
                expected_error=429,
            )
            if (
                overload_status != 429
                or not isinstance(overload_body, dict)
                or overload_body.get("code") != "run_backlog_full"
                or (store_root / "runs" / overload[1] / "run_intent.json").exists()
            ):
                raise ResourceDiscoveryRuntimeError(
                    "public Submit backlog did not reject overload before durable intent publication"
                )
            receipt["submit"] = {
                "health": health,
                "build_identity": build_identity,
                "cli": cli_submits,
                "backpressure": {
                    "limit": 6,
                    "replay_status": replay_status,
                    "replay": replay_body,
                    "overload_status": overload_status,
                    "overload": overload_body,
                    "intent_published": False,
                },
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
                "--discover-runs", "true",
                "--pool-id", pool_id,
                "--resident", "true",
                "--discover-resources", "true",
                "--worker-executable", str(binaries["fullmag-api-accepted-worker"]),
                "--max-concurrency", "1",
                "--max-queued-runs", "2",
                "--max-tasks", "4",
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
                or scheduler.get("scheduled_count") != 4
                or scheduler.get("run_source") != "store"
                or scheduler.get("max_queued_runs") != 2
                or scheduler.get("peak_queued_run_count") != 5
                or scheduler.get("peak_backpressured_run_count") != 3
                or scheduler.get("resource_source") != "store"
                or scheduler.get("resource_pool_generation") != 1
                or not isinstance(executed, list)
                or [item.get("run_id") for item in executed]
                != [request[1] for request in requests[:4]]
                or any(item.get("resource_id") != cpu_offer["resource_id"] for item in executed)
                or any(item.get("worker", {}).get("status") != "completed" for item in executed)
            ):
                raise ResourceDiscoveryRuntimeError(
                    "scheduler did not preserve strict priority and equal-priority fairness"
                )
            receipt["scheduler"] = scheduler

            leases_by_run = {}
            worker_control_by_run = {}
            for _, executed_run_id, _, _ in requests[:4]:
                leases = durable_leases(store_root, executed_run_id)
                if len(leases) != 1 or any(
                    lease.get("state") != "released"
                    or lease.get("released_at") is None
                    or lease.get("resource_id") != cpu_offer["resource_id"]
                    for lease in leases
                ):
                    raise ResourceDiscoveryRuntimeError(
                        "an exact discovered resource lease was not durably released"
                    )
                leases_by_run[executed_run_id] = leases
                worker_control_by_run[executed_run_id] = worker_control_evidence(
                    store_root, executed_run_id, leases[0]
                )
            receipt["resource_leases"] = leases_by_run
            receipt["worker_control"] = worker_control_by_run

            api_process, api_log, result_url = start_api(
                binaries["fullmag-api"], repo_root, env, paths["api_result_log"]
            )
            wait_for_health(result_url, api_process)
            released_status, released_body = json_request(
                f"{result_url}/v2/persistence/projects/{project_id}/runs",
                method="POST",
                payload=overload[3],
            )
            if (
                released_status != 201
                or not isinstance(released_body, dict)
                or released_body.get("disposition") != "accepted"
                or released_body.get("run_id") != overload[1]
            ):
                raise ResourceDiscoveryRuntimeError(
                    "terminal runs did not release public Submit backlog capacity"
                )
            receipt["submit"]["backpressure"]["after_terminal_status"] = released_status
            receipt["submit"]["backpressure"]["after_terminal"] = released_body

            materialization_status, materialization = json_request(
                f"{result_url}/v2/persistence/projects/{project_id}/runs/{overload[1]}"
                "/materialization",
                method="POST",
            )
            task_ids = (
                materialization.get("task_ids", [])
                if isinstance(materialization, dict)
                else []
            )
            if materialization_status != 200 or len(task_ids) != 1:
                raise ResourceDiscoveryRuntimeError(
                    "cancellation proof run did not materialize exactly one task"
                )
            cancellation_scheduler_command = [
                str(binaries["fullmag-api-accepted-scheduler"]),
                "--store-root", str(store_root),
                "--discover-runs", "true",
                "--pool-id", pool_id,
                "--resident", "true",
                "--discover-resources", "true",
                "--worker-executable", str(binaries["fullmag-api-accepted-worker"]),
                "--max-concurrency", "1",
                "--max-queued-runs", "2",
                "--max-tasks", "1",
                "--max-idle-polls", "0",
                "--idle-poll-milliseconds", "20",
                "--worker-timeout-seconds", "60",
                "--heartbeat-interval-milliseconds", "250",
                "--max-automatic-retries", "0",
            ]
            cancellation = run_worker_cancellation_scenario(
                cancellation_scheduler_command,
                cwd=repo_root,
                env=env,
                log_path=paths["scheduler_cancel_log"],
                base_url=result_url,
                project_id=project_id,
                run_id=overload[1],
                task_id=str(task_ids[0]),
            )
            cancellation_leases = durable_leases(store_root, overload[1])
            if (
                len(cancellation_leases) != 1
                or cancellation_leases[0].get("state") != "released"
                or cancellation_leases[0].get("released_at") is None
            ):
                raise ResourceDiscoveryRuntimeError(
                    "worker cancellation did not release its exact resource lease"
                )
            cancellation["worker_control"] = worker_control_evidence(
                store_root,
                overload[1],
                cancellation_leases[0],
                expected_terminal="stopped",
            )
            cancellation["resource_leases"] = cancellation_leases
            _, cancelled_run = json_request(
                f"{result_url}/v2/persistence/projects/{project_id}/runs/{overload[1]}"
            )
            cancelled_tasks = cancelled_run.get("tasks", [])
            if (
                len(cancelled_tasks) != 1
                or cancelled_tasks[0].get("lifecycle") != "cancelled"
            ):
                raise ResourceDiscoveryRuntimeError(
                    "public run projection did not expose worker-acknowledged cancellation"
                )
            cancellation["run"] = cancelled_run
            receipt["cancellation"] = cancellation

            after_scheduler = {}
            for label, expected_run_id, priority, _ in requests:
                _, after = json_request(
                    f"{result_url}/v2/persistence/projects/{project_id}/runs/{expected_run_id}"
                )
                after_tasks = after.get("tasks", [])
                if label == "unmaterialized":
                    lifecycle_matches = (
                        after.get("catalog_state") == "pending_materialization"
                        and not after_tasks
                    )
                else:
                    expected_lifecycle = "accepted" if label == "low" else "succeeded"
                    lifecycle_matches = (
                        len(after_tasks) == 1
                        and after_tasks[0].get("lifecycle") == expected_lifecycle
                    )
                if after.get("scheduling_priority") != priority or not lifecycle_matches:
                    raise ResourceDiscoveryRuntimeError(
                        "public run projection did not preserve priority ordering and lifecycle"
                    )
                if after.get("requested_execution", {}).get("minimum_resources") != run_minimum:
                    raise ResourceDiscoveryRuntimeError("public run projection lost immutable resource minima")
                after_scheduler[label] = after
            receipt["after_scheduler"] = after_scheduler
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
