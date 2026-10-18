"""Verify durable pre-claim cancellation through the native API and scheduler."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

import fullmag_storage as storage
from windows.verify_compute_cancellation_api import (
    _api_environment,
    _canonical_json_sha256,
    _http_json,
    _run_store_initializer,
    _task,
    _utc_now,
    _valid_api_instance_id,
    _valid_platform_health,
)
from windows.verify_compute_host_initialization import (
    _canonical_windows_path,
    _expected_store_id,
    _fixture_config,
)


API_START_TIMEOUT_SECONDS = 20
CHILD_START_TIMEOUT_SECONDS = 20
CHILD_EXIT_TIMEOUT_SECONDS = 30
HTTP_TIMEOUT_SECONDS = 5
POLL_INTERVAL_SECONDS = 0.2
RUN_ID = "run-scheduler-cancellation-fixture"
PROJECT_ID = "project-scheduler-cancellation-fixture"
TASK_IDS = ("task-scheduler-cancel-accepted", "task-scheduler-cancel-queued")


def _persist(path: Path, evidence: dict) -> None:
    storage.atomic_json(path, evidence)


def _write_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def _check(name: str, condition: bool, evidence: dict, evidence_path: Path,
           receipt: dict, detail: object = None) -> None:
    if not condition:
        raise AssertionError(f"{name} failed: {detail!r}")
    evidence["checks"].append(name)
    receipt["checks"].append("compute-scheduler-cancellation-" + name)
    _persist(evidence_path, evidence)


def _json_lines(path: Path) -> list[dict]:
    if not path.exists():
        return []
    values = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            values.append(value)
    return values


def _record_process(receipt: dict, evidence: dict, record: dict,
                    evidence_path: Path) -> None:
    if record not in receipt["processes"]:
        receipt["processes"].append(record)
    evidence["processes"].append(dict(record))
    _persist(evidence_path, evidence)


def _reap_owned_child(child: subprocess.Popen, record: dict,
                      *, send_drain: bool = False) -> None:
    if child.poll() is None and send_drain and child.stdin is not None:
        try:
            child.stdin.write(b"\x01")
            child.stdin.flush()
            child.stdin.close()
            record["cleanup_drain_requested"] = True
        except (BrokenPipeError, OSError) as error:
            record["cleanup_drain_error"] = f"{type(error).__name__}: {error}"
    if child.poll() is None:
        record["stop_requested_by_verifier"] = True
        try:
            child.terminate()
        except OSError:
            pass
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            record["forced_exit_of_owned_child"] = True
            try:
                child.kill()
            except OSError:
                pass
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                record["wait_error"] = f"{type(error).__name__}: {error}"
    record["exit_code"] = child.poll()
    record["waited"] = child.poll() is not None


def _run_short_native(executable: Path, arguments: list[str], repo: Path,
                      environment: dict[str, str], log_path: Path, label: str,
                      receipt: dict, evidence: dict, evidence_path: Path,
                      *, timeout_seconds: int = CHILD_EXIT_TIMEOUT_SECONDS) -> tuple[int, object, str]:
    record = {
        "label": label,
        "pid": None,
        "log_path": str(log_path),
        "waited": False,
        "arguments": [str(executable), *arguments],
    }
    receipt["processes"].append(record)
    child: subprocess.Popen | None = None
    try:
        with log_path.open("wb") as log:
            child = subprocess.Popen(
                [str(executable), *arguments],
                cwd=repo,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            record["pid"] = child.pid
            try:
                record["exit_code"] = child.wait(timeout=timeout_seconds)
                record["waited"] = child.poll() is not None
            except subprocess.TimeoutExpired:
                record["timed_out"] = True
                _reap_owned_child(child, record)
        output = log_path.read_text(encoding="utf-8", errors="replace")
        record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        record["output_sha256"] = hashlib.sha256(output.encode("utf-8")).hexdigest()
        _record_process(receipt, evidence, record, evidence_path)
        if record.get("timed_out"):
            raise TimeoutError(f"Owned native child exceeded its timeout: {record!r}")
        if not record["waited"]:
            raise RuntimeError(f"Owned native child was not reaped: {record!r}")
        body: object = None
        if record["exit_code"] == 0:
            for line in reversed(output.splitlines()):
                try:
                    body = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
            if not isinstance(body, dict):
                raise RuntimeError(f"Native command omitted its JSON result: {label}")
        return int(record["exit_code"]), body, output
    except BaseException as error:
        if child is not None:
            _reap_owned_child(child, record)
        record["error"] = f"{type(error).__name__}: {error}"
        if log_path.exists():
            record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        if not any(item.get("pid") == record.get("pid") for item in evidence["processes"]):
            _record_process(receipt, evidence, record, evidence_path)
        else:
            _persist(evidence_path, evidence)
        raise


def _ensure_api(api: Path, repo: Path, environment: dict[str, str], port: int,
                run_root: Path, receipt: dict, evidence: dict,
                evidence_path: Path) -> tuple[subprocess.Popen, dict]:
    log_path = run_root / "compute-scheduler-cancellation-api.log"
    record = {
        "label": "compute-scheduler-cancellation-owned-native-api",
        "pid": None,
        "port": port,
        "log_path": str(log_path),
        "waited": False,
    }
    receipt["processes"].append(record)
    child: subprocess.Popen | None = None
    try:
        with log_path.open("wb") as log:
            child = subprocess.Popen(
                [str(api)],
                cwd=repo,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        record["pid"] = child.pid
        health_path = "/v2/platform/health"
        deadline = time.monotonic() + API_START_TIMEOUT_SECONDS
        while True:
            if child.poll() is not None:
                raise RuntimeError(f"Owned native API exited during startup: {log_path}")
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{port}{health_path}")
                with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                    instance_id = response.headers.get("x-fullmag-api-instance")
                    if response.status == 200 and _valid_api_instance_id(instance_id):
                        evidence["api_instance_id"] = instance_id
                        break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Owned native API did not become ready: {log_path}")
                time.sleep(0.1)
        status, body = _http_json(port, health_path, evidence, evidence_path)
        _check(
            "owned-api-ready",
            status == 200 and _valid_platform_health(body)
            and _valid_api_instance_id(evidence.get("api_instance_id")),
            evidence, evidence_path, receipt,
            {"status": status, "body": body},
        )
        record["api_instance_id"] = evidence["api_instance_id"]
        return child, record
    except BaseException as error:
        if child is not None:
            _reap_owned_child(child, record)
        record["error"] = f"{type(error).__name__}: {error}"
        if log_path.exists():
            record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        if not any(item.get("pid") == record.get("pid") for item in evidence["processes"]):
            _record_process(receipt, evidence, record, evidence_path)
        else:
            _persist(evidence_path, evidence)
        raise


def _stop_api_after_idle(child: subprocess.Popen, record: dict,
                         evidence: dict, evidence_path: Path,
                         receipt: dict) -> None:
    if child.poll() is None:
        record["stop_requested_by_verifier"] = True
        try:
            child.terminate()
        except OSError:
            pass
        try:
            record["exit_code"] = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            record["forced_exit_of_owned_child"] = True
            child.kill()
            try:
                record["exit_code"] = child.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                record["wait_error"] = f"{type(error).__name__}: {error}"
    record["waited"] = child.poll() is not None
    log_path = Path(record["log_path"])
    if log_path.exists():
        record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
    record["graceful_api_drain_claimed"] = False
    evidence["api_stopped_after_idle_fixture"] = bool(
        evidence.get("idle_cancellations_verified") and record["waited"]
    )
    if record not in evidence["processes"]:
        evidence["processes"].append(dict(record))
    if not record["waited"]:
        evidence["state"] = "failed"
        evidence["cleanup_failure"] = "owned API process was not reaped"
    _persist(evidence_path, evidence)
    if not record["waited"]:
        raise RuntimeError("Owned API process was not reaped after fixture completion")


def _wait_for_scheduler_event(child: subprocess.Popen, log_path: Path,
                              event: str, *, timeout_seconds: int) -> dict:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError(
                f"Accepted scheduler exited before {event}: {log_path.read_text(encoding='utf-8', errors='replace')}"
            )
        matching = [
            item for item in _json_lines(log_path)
            if item.get("schema_version") == "scheduler_owner_event.v1"
            and item.get("event") == event
        ]
        if matching:
            return matching[-1]
        time.sleep(0.05)
    raise TimeoutError(f"Accepted scheduler did not announce {event}: {log_path}")


def _run_scheduler_cycle(scheduler_executable: Path, repo: Path,
                         environment: dict[str, str], store_root: Path,
                         run_id: str, pool_id: str, config_path: Path,
                         config_sha256: str, worker_timeout_seconds: int,
                         heartbeat_interval_milliseconds: int, cycle: int, receipt: dict,
                         evidence: dict, evidence_path: Path) -> tuple[dict, list[dict]]:
    log_path = evidence_path.parent / f"compute-scheduler-cancellation-scheduler-{cycle}.log"
    arguments = [
        "--store-root", str(store_root),
        "--run-id", run_id,
        "--pool-id", pool_id,
        "--resident", "true",
        "--discover-resources", "true",
        "--host-service-config", str(config_path),
        "--host-config-sha256", config_sha256,
        "--worker-timeout-seconds", str(worker_timeout_seconds),
        "--heartbeat-interval-milliseconds", str(heartbeat_interval_milliseconds),
        "--max-concurrency", "1",
        "--max-tasks", "1",
        "--max-idle-polls", "0",
        "--idle-poll-milliseconds", "100",
        "--owner-control", "stdin-v1",
    ]
    record = {
        "label": f"compute-scheduler-cancellation-accepted-scheduler-cycle-{cycle}",
        "pid": None,
        "log_path": str(log_path),
        "waited": False,
        "argv": [str(scheduler_executable), *arguments],
        "runtime_service_owner_token_supplied": False,
        "startup_gate_supplied": False,
    }
    receipt["processes"].append(record)
    log = log_path.open("wb")
    child: subprocess.Popen | None = None
    try:
        child = subprocess.Popen(
            [str(scheduler_executable), *arguments],
            cwd=repo,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=log,
            stderr=subprocess.STDOUT,
            bufsize=0,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        record["pid"] = child.pid
        ready = _wait_for_scheduler_event(
            child, log_path, "ready", timeout_seconds=CHILD_START_TIMEOUT_SECONDS
        )
        if child.stdin is None:
            raise RuntimeError("Accepted scheduler has no owner-control stdin pipe")
        child.stdin.write(b"\x01")
        child.stdin.flush()
        child.stdin.close()
        record["explicit_drain_token_sent"] = True
        try:
            record["exit_code"] = child.wait(timeout=CHILD_EXIT_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            record["timed_out_after_drain"] = True
            _reap_owned_child(child, record)
        record["waited"] = child.poll() is not None
        log.close()
        record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        lines = _json_lines(log_path)
        summaries = [
            item for item in lines
            if "scheduled_count" in item and "executed" in item
        ]
        drains = [
            item for item in lines
            if item.get("schema_version") == "scheduler_owner_event.v1"
            and item.get("event") == "drained"
        ]
        record["summary_count"] = len(summaries)
        record["drained_event_count"] = len(drains)
        _record_process(receipt, evidence, record, evidence_path)
        if not record["waited"] or record.get("exit_code") != 0:
            raise RuntimeError(f"Accepted scheduler did not exit cleanly: {record!r}")
        if record.get("timed_out_after_drain"):
            raise TimeoutError(f"Accepted scheduler exceeded its drain timeout: {record!r}")
        if len(summaries) != 1 or len(drains) != 1:
            raise RuntimeError(f"Accepted scheduler omitted its unique summary or drain event: {record!r}")
        if (
            ready.get("owner_token") is not None
            or drains[0].get("owner_token") is not None
            or ready.get("role") != "compute"
            or drains[0].get("role") != "compute"
            or ready.get("protocol") != "stdin-v1"
            or drains[0].get("protocol") != "stdin-v1"
            or ready.get("git_commit") != environment.get("FULLMAG_RUNTIME_SERVICE_SOURCE_COMMIT")
            or ready.get("source_snapshot_sha256") != environment.get("FULLMAG_RUNTIME_SERVICE_SOURCE_SNAPSHOT")
        ):
            raise RuntimeError("Standalone scheduler owner-control event differs from the pinned component contract")
        return summaries[0], lines
    except BaseException as error:
        if child is not None:
            _reap_owned_child(child, record, send_drain=True)
        if not log.closed:
            log.close()
        record["error"] = f"{type(error).__name__}: {error}"
        if log_path.exists():
            record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        if not any(item.get("pid") == record.get("pid") for item in evidence["processes"]):
            _record_process(receipt, evidence, record, evidence_path)
        else:
            _persist(evidence_path, evidence)
        raise


def _wait_for_cancelled_run(port: int, base: str, evidence: dict,
                            evidence_path: Path, receipt: dict,
                            deadline_seconds: int = 20) -> dict:
    deadline = time.monotonic() + deadline_seconds
    last_status: int | None = None
    last_body: object = None
    while time.monotonic() < deadline:
        last_status, last_body = _http_json(port, base, evidence, evidence_path)
        if last_status == 200 and isinstance(last_body, dict):
            tasks = last_body.get("tasks")
            if isinstance(tasks, list) and all(
                sum(item.get("task_id") == task_id and item.get("lifecycle") == "cancelled"
                    for item in tasks) == 1
                for task_id in TASK_IDS
            ):
                return last_body
        elif last_status not in {409}:
            raise RuntimeError(f"Run read failed while waiting for scheduler cancellation: {last_status}, {last_body!r}")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise TimeoutError(
        f"Scheduler did not project both cancellations: {last_status}, {last_body!r}"
    )


def _assert_cancelled_unclaimed(task: dict) -> None:
    if task.get("lifecycle") != "cancelled":
        raise AssertionError(f"task did not become Cancelled: {task!r}")
    for field in (
        "attempt_id", "ownership_epoch", "resource_id", "observation",
        "coordinator_watermark", "coordinator_genesis", "admission", "lease",
    ):
        if task.get(field) is not None:
            raise AssertionError(f"cancelled unclaimed task has {field}: {task!r}")


def _run_files(run_directory: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    for current, subdirectories, names in os.walk(run_directory, followlinks=False):
        current_path = Path(current)
        for name in subdirectories:
            path = current_path / name
            if path.is_symlink():
                raise RuntimeError(f"run fixture contains a symbolic directory: {path}")
            directories.add(path.relative_to(run_directory).as_posix())
        for name in names:
            path = current_path / name
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"run fixture contains a non-regular file: {path}")
            files.add(path.relative_to(run_directory).as_posix())
    return files, directories


def _assert_expected_unclaimed(task: dict, *, queued: bool) -> None:
    expected = "queued" if queued else "accepted"
    if task.get("lifecycle") != expected:
        raise AssertionError(f"fixture task is not {expected}: {task!r}")
    for field in (
        "attempt_id", "ownership_epoch", "resource_id", "observation",
        "coordinator_watermark", "coordinator_genesis", "admission", "lease",
    ):
        if task.get(field) is not None:
            raise AssertionError(f"unclaimed task has {field}: {task!r}")


def _read_terminal_run(port: int, base: str, evidence: dict,
                       evidence_path: Path, receipt: dict) -> dict:
    status, body = _http_json(port, base, evidence, evidence_path)
    _check(
        "terminal-run-read-succeeds",
        status == 200 and isinstance(body, dict),
        evidence, evidence_path, receipt,
        {"status": status, "body": body},
    )
    return body


def _assert_terminal_store_state(store_root: Path, run_directory: Path,
                                 ledger_root: Path, read_model: dict,
                                 cancellation_requests: list[dict]) -> dict:
    if run_directory != store_root / "runs" / RUN_ID:
        raise AssertionError("terminal run path differs from the scoped store identity")
    catalog_path = run_directory / "run_catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if catalog.get("revision") != read_model.get("catalog_revision"):
        raise AssertionError("API run revision differs from durable catalog revision")
    expected_by_task = {item["task_id"]: item for item in cancellation_requests}
    if {item.get("task_id") for item in catalog.get("tasks", [])} != set(TASK_IDS):
        raise AssertionError("durable run catalog contains tasks outside the two-item fixture")
    for task_id in TASK_IDS:
        api_task = _task(read_model, task_id)
        _assert_cancelled_unclaimed(api_task)
        intent = api_task.get("cancellation_intent")
        if not isinstance(intent, dict) or intent.get("cancellation_id") != expected_by_task[task_id]["payload"]["cancellation_id"]:
            raise AssertionError(f"API read model lost cancellation identity for {task_id}")
        catalog_task = next(
            (item for item in catalog.get("tasks", []) if item.get("task_id") == task_id),
            None,
        )
        if not isinstance(catalog_task, dict) or catalog_task.get("lifecycle") != "cancelled":
            raise AssertionError(f"durable catalog did not cancel {task_id}: {catalog_task!r}")
        for field in (
            "attempt_id", "ownership_epoch", "resource_id", "observation",
            "coordinator_watermark", "coordinator_genesis",
        ):
            if catalog_task.get(field) is not None:
                raise AssertionError(f"durable task {task_id} has {field}: {catalog_task!r}")
        intent_path = run_directory / "task_cancellation_intents" / f"{task_id}.json"
        persisted_intent = json.loads(intent_path.read_text(encoding="utf-8"))
        expected_payload = expected_by_task[task_id]["payload"]
        if (
            persisted_intent.get("cancellation_id") != expected_payload["cancellation_id"]
            or persisted_intent.get("expected_catalog_revision") != expected_payload["expected_catalog_revision"]
        ):
            raise AssertionError(f"durable cancellation identity differs for {task_id}")

    expected_files = {
        "run_intent.json",
        "run_catalog.json",
        *(f"task_cancellation_intents/{task_id}.json" for task_id in TASK_IDS),
    }
    files, directories = _run_files(run_directory)
    if files != expected_files or directories != {"task_cancellation_intents"}:
        raise AssertionError(
            f"run acquired unexpected claim/event/lease files: files={sorted(files)}, dirs={sorted(directories)}"
        )
    ledger_document = json.loads(
        (ledger_root / "HOST_RESOURCE_LEDGER.json").read_text(encoding="utf-8")
    )
    if ledger_document.get("reservations") != []:
        raise AssertionError(f"scheduler created host reservations for unclaimed cancellation: {ledger_document!r}")
    return {
        "catalog_revision": catalog["revision"],
        "task_lifecycles": {task_id: _task(read_model, task_id).get("lifecycle") for task_id in TASK_IDS},
        "run_files": sorted(files),
        "run_directories": sorted(directories),
        "host_reservation_count": 0,
    }


def _replay_cancellations(port: int, cancellation_requests: list[dict],
                          final: dict, evidence: dict, evidence_path: Path,
                          receipt: dict) -> None:
    current_revision = final.get("catalog_revision")
    for request in cancellation_requests:
        status, body = _http_json(
            port, request["path"], evidence, evidence_path,
            method="POST", payload=request["payload"],
        )
        _check(
            "terminal-cancellation-replay-preserves-identity-and-current-revision-"
            + request["task_id"],
            status == 200
            and isinstance(body, dict)
            and body.get("disposition") == "replayed"
            and body.get("cancellation_id") == request["payload"]["cancellation_id"]
            and body.get("expected_catalog_revision") == request["payload"]["expected_catalog_revision"]
            and body.get("catalog_revision") == current_revision
            and "command_id" not in body,
            evidence, evidence_path, receipt,
            {"status": status, "body": body, "current_catalog_revision": current_revision},
        )


def _pin_runtime_source(environment: dict[str, str], receipt: dict) -> dict[str, str]:
    commit = receipt.get("build_commit")
    snapshot = receipt.get("build_snapshot_sha256")
    if not isinstance(commit, str) or not isinstance(snapshot, str):
        raise RuntimeError("Parent receipt lacks the verified native build identity")
    if len(commit) != 40 or len(snapshot) != 64:
        raise RuntimeError("Parent receipt contains an invalid native source identity")
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or not re.fullmatch(r"[0-9a-f]{64}", snapshot):
        raise RuntimeError("Parent receipt source identity is not canonical lowercase SHA")
    pinned = dict(environment)
    pinned["FULLMAG_RUNTIME_SERVICE_SOURCE_COMMIT"] = commit
    pinned["FULLMAG_RUNTIME_SERVICE_SOURCE_SNAPSHOT"] = snapshot
    pinned.pop("FULLMAG_RUNTIME_SERVICE_OWNER", None)
    return pinned


def exercise(api: Path, repo: Path, run_root: Path, receipt: dict) -> None:
    """Prove the standalone native API/scheduler component cancellation path."""
    fixture_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    evidence_path = run_root / "compute-scheduler-cancellation-evidence.json"
    evidence = {
        "schema": "fullmag.compute-scheduler-cancellation-evidence.v1",
        "state": "running",
        "fixture_sha256": fixture_sha256,
        "fixture_seeded": False,
        "qualification": (
            "standalone native API and accepted-scheduler component proof for durable "
            "pre-claim cancellation with a synthetic unclaimed RunSpec/catalog; no "
            "runtime_service owner lifecycle, Submit, physical host topology, OS "
            "enforcement, worker/solver execution, resource release, physics, or full E0-E7 qualification"
        ),
        "fixture_metadata": (
            "two seeded unclaimed Accepted/Queued tasks and one synthetic CPU-only "
            "host policy; fixture is not Submit or scientific evidence"
        ),
        "http": [],
        "processes": [],
        "checks": [],
        "idle_cancellations_verified": False,
    }
    receipt.setdefault("checks", [])
    receipt.setdefault("processes", [])
    _persist(evidence_path, evidence)
    api_child: subprocess.Popen | None = None
    api_record: dict | None = None
    try:
        if os.name != "nt":
            raise RuntimeError("Managed native scheduler cancellation verification is Windows-only")
        native = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
        initializer = api.parent / "fullmag.exe"
        pool_executable = api.parent / "fullmag-api-resource-pool.exe"
        scheduler_executable = api.parent / "fullmag-api-accepted-scheduler.exe"
        for executable in (initializer, pool_executable, scheduler_executable):
            if not executable.is_file():
                raise RuntimeError(f"Verified native package is missing {executable.name}")

        scope = str(uuid.uuid4())
        scope_root = Path(native["runs_root"]) / "workspaces" / scope
        if os.path.lexists(scope_root):
            raise RuntimeError("Unique scheduler-cancellation scope already exists")
        store_root = scope_root / "session-store"
        fixture_root = run_root / "compute-scheduler-cancellation-fixture"
        fixture_root.mkdir(parents=True, exist_ok=False)
        port_reservation = socket.socket()
        try:
            port_reservation.bind(("127.0.0.1", 0))
            api_port = int(port_reservation.getsockname()[1])
        finally:
            port_reservation.close()
        environment = _api_environment(repo, fixture_root, native, api_port, scope)
        Path(environment["FULLMAG_STATE_ROOT"]).mkdir(parents=True, exist_ok=False)
        evidence.update(
            accepted_store_scope=scope,
            accepted_store_root=str(store_root),
            api_port=api_port,
            synthetic_topology_sha256=hashlib.sha256(
                b"fullmag synthetic host initialization topology fixture v1"
            ).hexdigest(),
            runtime_service_owner_token_supplied=False,
            runtime_service_startup_gate_supplied=False,
        )
        _persist(evidence_path, evidence)

        store_process_start = len(receipt["processes"])
        try:
            _run_store_initializer(initializer, repo, environment, fixture_root, receipt)
        finally:
            if len(receipt["processes"]) > store_process_start:
                store_process = receipt["processes"][store_process_start]
                store_process["label"] = "compute-scheduler-cancellation-scoped-store-initialize"
                store_process["log_path"] = str(fixture_root / "compute-cancellation-store-init.log")
                evidence["processes"].append(dict(store_process))
                _persist(evidence_path, evidence)
        if not store_root.is_dir() or not (store_root / "objects").is_dir():
            raise RuntimeError("Production CLI did not initialize the scoped SessionStore")
        store_root = Path(_canonical_windows_path(store_root))
        evidence["accepted_store_root"] = str(store_root)
        _persist(evidence_path, evidence)

        config = _fixture_config(store_root)
        config_path = fixture_root / "operator-host-config.json"
        _write_json(config_path, config)
        config_sha256 = _canonical_json_sha256(config)
        init_code, init_body, _init_output = _run_short_native(
            initializer,
            [
                "runtime", "initialize-host-application",
                "--config", str(config_path),
                "--config-sha256", config_sha256,
            ],
            repo, environment,
            fixture_root / "compute-scheduler-cancellation-host-initialize.log",
            "compute-scheduler-cancellation-initialize-host-application",
            receipt, evidence, evidence_path,
        )
        expected_store_id = _expected_store_id(store_root)
        application_path = store_root / "runtime-services" / "APPLICATION.json"
        ledger_root = Path(config["host_execution"]["ledger_root"])
        ledger_path = ledger_root / "HOST_RESOURCE_LEDGER.json"
        ledger_marker_path = ledger_root / "HOST_RESOURCE_LEDGER.init.json"
        application_document = json.loads(application_path.read_text(encoding="utf-8"))
        ledger_document = json.loads(ledger_path.read_text(encoding="utf-8"))
        _check(
            "host-policy-initialized-by-native-cli",
            init_code == 0
            and isinstance(init_body, dict)
            and init_body.get("status") == "configuration_and_ledger_ready"
            and init_body.get("configuration_sha256") == config_sha256
            and init_body.get("store_id") == expected_store_id
            and init_body.get("target_id") == config["target_id"]
            and init_body.get("host_id") == config["host_execution"]["policy"]["host_id"]
            and init_body.get("policy_revision") == config["host_execution"]["policy"]["revision"]
            and init_body.get("owner_epoch") == config["host_execution"]["policy"]["owner_epoch"]
            and init_body.get("topology_sha256") == config["host_execution"]["policy"]["topology_sha256"]
            and init_body.get("execution_available") is False
            and application_document == config
            and ledger_document.get("policy") == config["host_execution"]["policy"]
            and application_path.is_file()
            and ledger_marker_path.is_file()
            and ledger_document.get("reservations") == [],
            evidence, evidence_path, receipt,
            {"exit_code": init_code, "response": init_body, "config_sha256": config_sha256},
        )
        evidence["host_config_path"] = str(config_path)
        evidence["host_config_sha256"] = config_sha256
        evidence["host_ledger_root"] = str(ledger_root)
        evidence["host_store_id"] = expected_store_id
        _persist(evidence_path, evidence)

        specification = {
            "schema_version": "run_spec.v2",
            "run_id": RUN_ID,
            "snapshot": {
                "project_id": PROJECT_ID,
                "definition_revision": 1,
                "definition_sha256": "a" * 64,
            },
            "study": {
                "study_id": "study-scheduler-cancellation-fixture",
                "plan_version": "study_plan.v2",
                "plan_sha256": "b" * 64,
            },
            "study_catalog_sha256": "c" * 64,
            "parameters": {"fixture_seeded": True},
            "seeds": {},
            "dependencies": [],
            "immutable_assets": [],
            "requested_execution": {
                "backend": "fdm",
                "device": "cpu",
                "precision": "double",
                "mode": "strict",
                "minimum_resources": {
                    "cpu_millis": 100,
                    "memory_bytes": 1,
                    "gpu_memory_bytes": 0,
                    "storage_bytes": 1,
                },
            },
        }
        run_directory = store_root / "runs" / RUN_ID
        run_directory.mkdir(parents=True, exist_ok=False)
        intent = {
            "schema_version": "run_intent.v1",
            "run_id": RUN_ID,
            "idempotency_key": "fixture-scheduler-cancellation-001",
            "payload_sha256": _canonical_json_sha256(specification),
            "accepted_at": _utc_now(),
            "specification": specification,
        }
        initial_catalog = {
            "schema_version": "run_catalog.v1",
            "run_id": RUN_ID,
            "revision": 1,
            "updated_at": _utc_now(),
            "tasks": [
                {
                    "task_id": task_id,
                    "input_fingerprint": hashlib.sha256(task_id.encode("ascii")).hexdigest(),
                    "lifecycle": "queued" if index == 1 else "accepted",
                    "readiness": {"state": "ready"} if index == 1 else {
                        "state": "blocked",
                        "reason": "accepted_task_awaiting_preparation",
                    },
                    "artifact_ids": [],
                }
                for index, task_id in enumerate(TASK_IDS)
            ],
        }
        storage.atomic_json(run_directory / "run_intent.json", intent)
        storage.atomic_json(run_directory / "run_catalog.json", initial_catalog)
        evidence.update(
            run_id=RUN_ID,
            project_id=PROJECT_ID,
            seeded_task_ids=list(TASK_IDS),
            fixture_seeded=True,
            seed_state="two_unclaimed_accepted_queued_tasks_before_api_start",
            run_intent_sha256=hashlib.sha256(
                (run_directory / "run_intent.json").read_bytes()
            ).hexdigest(),
            run_catalog_sha256=hashlib.sha256(
                (run_directory / "run_catalog.json").read_bytes()
            ).hexdigest(),
        )
        _persist(evidence_path, evidence)

        api_child, api_record = _ensure_api(
            api, repo, environment, api_port, run_root, receipt, evidence, evidence_path
        )
        base = f"/v2/persistence/projects/{PROJECT_ID}/runs/{RUN_ID}"
        status, before = _http_json(api_port, base, evidence, evidence_path)
        _check(
            "seeded-run-visible-before-cancellation",
            status == 200
            and isinstance(before, dict)
            and before.get("run_id") == RUN_ID
            and before.get("project_id") == PROJECT_ID
            and before.get("catalog_revision") == 1
            and before.get("payload_fingerprint") == intent["payload_sha256"],
            evidence, evidence_path, receipt,
            {"status": status, "body": before},
        )
        if not isinstance(before, dict):
            raise AssertionError("run read model is not an object")
        for index, task_id in enumerate(TASK_IDS):
            _assert_expected_unclaimed(_task(before, task_id), queued=(index == 1))
        _check(
            "fixture-has-only-unclaimed-accepted-and-queued-tasks",
            len(before.get("tasks", [])) == 2
            and all(_task(before, task_id).get("cancellation_intent") is None for task_id in TASK_IDS),
            evidence, evidence_path, receipt,
            {"task_ids": list(TASK_IDS)},
        )

        cancellation_requests: list[dict] = []
        current = before
        for index, task_id in enumerate(TASK_IDS):
            expected_revision = current.get("catalog_revision")
            cancellation_id = str(uuid.uuid4())
            payload = {
                "reason": "fixture requests durable pre-claim cancellation",
                "cancellation_id": cancellation_id,
                "expected_catalog_revision": expected_revision,
            }
            cancel_path = base + "/tasks/" + task_id + "/cancellation"
            cancel_status, response = _http_json(
                api_port, cancel_path, evidence, evidence_path,
                method="POST", payload=payload,
            )
            expected_lifecycle = "queued" if index == 1 else "accepted"
            _check(
                f"{expected_lifecycle}-cancellation-recorded-before-scheduler-{index + 1}",
                cancel_status == 202
                and isinstance(response, dict)
                and response.get("disposition") == "accepted"
                and response.get("cancellation_id") == cancellation_id
                and response.get("expected_catalog_revision") == expected_revision
                and response.get("catalog_revision") == expected_revision + 1
                and response.get("lifecycle") == expected_lifecycle
                and response.get("cancellation_state") == "requested"
                and "command_id" not in response,
                evidence, evidence_path, receipt,
                {"status": cancel_status, "body": response},
            )
            cancellation_requests.append({
                "task_id": task_id,
                "path": cancel_path,
                "payload": payload,
                "lifecycle": expected_lifecycle,
            })
            status, current = _http_json(api_port, base, evidence, evidence_path)
            _check(
                f"cancellation-remains-requested-and-unclaimed-before-scheduler-{index + 1}",
                status == 200
                and isinstance(current, dict)
                and current.get("catalog_revision") == expected_revision + 1
                and _task(current, task_id).get("lifecycle") == expected_lifecycle
                and _task(current, task_id).get("cancellation_intent", {}).get("cancellation_id") == cancellation_id,
                evidence, evidence_path, receipt,
                {"status": status, "body": current},
            )
            _assert_expected_unclaimed(_task(current, task_id), queued=(index == 1))
            for other_index, other_task_id in enumerate(TASK_IDS):
                _assert_expected_unclaimed(
                    _task(current, other_task_id), queued=(other_index == 1)
                )

        pool_id = config["compute_pool_id"]
        resource_offer = config["compute_resources"][0]
        resource_offer_json = json.dumps(
            resource_offer, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        pinned_environment = _pin_runtime_source(environment, receipt)
        _check(
            "child-identity-is-pinned-without-service-owner-token",
            pinned_environment.get("FULLMAG_RUNTIME_SERVICE_SOURCE_COMMIT") == receipt["build_commit"]
            and pinned_environment.get("FULLMAG_RUNTIME_SERVICE_SOURCE_SNAPSHOT") == receipt["build_snapshot_sha256"]
            and "FULLMAG_RUNTIME_SERVICE_OWNER" not in pinned_environment,
            evidence, evidence_path, receipt,
            {"build_commit": receipt["build_commit"], "build_snapshot_sha256": receipt["build_snapshot_sha256"]},
        )
        pool_exit, pool_body, _pool_output = _run_short_native(
            pool_executable,
            [
                "--store-root", str(store_root),
                "--pool-id", pool_id,
                "--expected-generation", "0",
                "--resource-offer", resource_offer_json,
            ],
            repo, pinned_environment,
            run_root / "compute-scheduler-cancellation-resource-pool.log",
            "compute-scheduler-cancellation-publish-resource-pool",
            receipt, evidence, evidence_path,
        )
        pool_path = store_root / "scheduler_pools" / f"{pool_id}.resources.json"
        checkpoint_path = store_root / "scheduler_pools" / f"{pool_id}.json"
        _check(
            "resource-pool-published-by-native-cli",
            pool_exit == 0
            and isinstance(pool_body, dict)
            and pool_body.get("status") == "accepted"
            and pool_body.get("pool_id") == pool_id
            and pool_body.get("generation") == 1
            and pool_body.get("resources") == [resource_offer]
            and pool_path.is_file()
            and not checkpoint_path.exists(),
            evidence, evidence_path, receipt,
            {"exit_code": pool_exit, "response": pool_body},
        )
        pool_bytes = pool_path.read_bytes()
        pool_sha256 = hashlib.sha256(pool_bytes).hexdigest()
        evidence["resource_pool_path"] = str(pool_path)
        evidence["resource_pool_sha256"] = pool_sha256
        evidence["checkpoint_path"] = str(checkpoint_path)
        evidence["checkpoint_initially_absent"] = True
        _persist(evidence_path, evidence)

        scheduler_summaries = []
        for cycle in (1, 2):
            summary, scheduler_lines = _run_scheduler_cycle(
                scheduler_executable, repo, pinned_environment, store_root,
                RUN_ID, pool_id, config_path, config_sha256,
                config["worker_timeout_seconds"],
                config["heartbeat_interval_milliseconds"], cycle,
                receipt, evidence, evidence_path,
            )
            ready_events = [
                item for item in scheduler_lines
                if item.get("schema_version") == "scheduler_owner_event.v1"
                and item.get("event") == "ready"
            ]
            _check(
                f"standalone-scheduler-cycle-{cycle}-drained-without-execution",
                summary.get("status") == "drained"
                and summary.get("run_id") == RUN_ID
                and summary.get("run_ids") == [RUN_ID]
                and summary.get("run_source") == "explicit"
                and summary.get("scheduled_count") == 0
                and summary.get("executed") == []
                and summary.get("pool_id") == pool_id
                and summary.get("resource_source") == "store"
                and summary.get("resource_pool_generation") == 1
                and summary.get("resource_count") == 1
                and summary.get("resource_ids") == [resource_offer["resource_id"]]
                and summary.get("pool_checkpoint_sequence") == 0
                and summary.get("shutdown_requested") is True
                and len(ready_events) == 1
                and ready_events[0].get("generation") == 1
                and ready_events[0].get("pool_id") == pool_id
                and ready_events[0].get("role") == "compute"
                and ready_events[0].get("protocol") == "stdin-v1"
                and ready_events[0].get("owner_token") is None,
                evidence, evidence_path, receipt,
                {"summary": summary, "ready_events": ready_events},
            )
            scheduler_summaries.append(summary)
            if pool_path.read_bytes() != pool_bytes or checkpoint_path.exists():
                raise AssertionError("Scheduler replay changed the published resource pool or created a checkpoint")
            if cycle == 1:
                final = _wait_for_cancelled_run(
                    api_port, base, evidence, evidence_path, receipt
                )
                terminal_state = _assert_terminal_store_state(
                    store_root, run_directory, ledger_root, final, cancellation_requests
                )
                evidence["idle_cancellations_verified"] = True
                _persist(evidence_path, evidence)
                _check(
                    "real-scheduler-projects-both-durable-intents-to-cancelled",
                    True,
                    evidence, evidence_path, receipt,
                    terminal_state,
                )
                _replay_cancellations(
                    api_port, cancellation_requests, final,
                    evidence, evidence_path, receipt,
                )

        final_after_replay = _read_terminal_run(
            api_port, base, evidence, evidence_path, receipt
        )
        terminal_state_after_replay = _assert_terminal_store_state(
            store_root, run_directory, ledger_root, final_after_replay, cancellation_requests
        )
        _replay_cancellations(
            api_port, cancellation_requests, final_after_replay,
            evidence, evidence_path, receipt,
        )
        _check(
            "replay-restart-preserves-resource-pool-checkpoint-and-catalog",
            pool_path.read_bytes() == pool_bytes
            and not checkpoint_path.exists()
            and scheduler_summaries[0].get("scheduled_count") == scheduler_summaries[1].get("scheduled_count") == 0
            and final_after_replay.get("catalog_revision") == final.get("catalog_revision")
            and terminal_state_after_replay.get("host_reservation_count") == 0,
            evidence, evidence_path, receipt,
            {
                "resource_pool_sha256": pool_sha256,
                "checkpoint_absent": not checkpoint_path.exists(),
                "terminal_state": terminal_state_after_replay,
            },
        )
        _check(
            "verifier-source-remained-unchanged",
            hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == fixture_sha256,
            evidence, evidence_path, receipt, fixture_sha256,
        )
        evidence["state"] = "completed"
        receipt["compute_scheduler_cancellation_fixture_seeded"] = True
        receipt["compute_scheduler_cancellation_fixture_sha256"] = fixture_sha256
        receipt["compute_scheduler_cancellation_evidence"] = str(evidence_path)
        receipt["compute_scheduler_cancellation_qualification"] = evidence["qualification"]
    except Exception as error:
        evidence["state"] = "failed"
        evidence["failure"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        if api_child is not None and api_record is not None:
            try:
                _stop_api_after_idle(api_child, api_record, evidence, evidence_path, receipt)
            except Exception as cleanup_error:
                evidence["state"] = "failed"
                evidence["cleanup_failure"] = f"{type(cleanup_error).__name__}: {cleanup_error}"
        _persist(evidence_path, evidence)
