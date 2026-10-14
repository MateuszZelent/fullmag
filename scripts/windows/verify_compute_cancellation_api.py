"""Exercise durable pre-claim cancellation through an owned native API."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

import fullmag_storage as storage


HTTP_TIMEOUT_SECONDS = 5
HTTP_BODY_LIMIT_BYTES = 1024 * 1024
WRITER_LOCK_DESCRIPTOR = b"fullmag.writer.lock.v1\n"


def _canonical_json_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _persist_evidence(path: Path, evidence: dict) -> None:
    storage.atomic_json(path, evidence)


def _valid_api_instance_id(value: object) -> bool:
    try:
        parsed = uuid.UUID(value)
    except (TypeError, ValueError, AttributeError):
        return False
    return parsed.int != 0 and str(parsed) == value


def _valid_platform_health(body: object) -> bool:
    return (
        isinstance(body, dict)
        and set(body) == {"status", "uptime_seconds", "api_contract_version", "active_session"}
        and body.get("status") == "ok"
        and type(body.get("uptime_seconds")) is int
        and body["uptime_seconds"] >= 0
        and body.get("api_contract_version") == "1.0.0"
        and type(body.get("active_session")) is bool
    )


def _http_json(port: int, path: str, evidence: dict, evidence_path: Path,
               *, method: str = "GET", payload: dict | None = None) -> tuple[int, object]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    expected_instance_id = evidence.get("api_instance_id")
    if expected_instance_id is not None:
        headers["x-fullmag-api-instance"] = expected_instance_id
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        method=method,
        headers=headers,
        data=body,
    )
    record = {"method": method, "path": path, "request": payload}
    response_instance_id = None
    try:
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                raw = response.read(HTTP_BODY_LIMIT_BYTES + 1)
                status = response.status
                response_instance_id = response.headers.get("x-fullmag-api-instance")
        except urllib.error.HTTPError as error:
            raw = error.read(HTTP_BODY_LIMIT_BYTES + 1)
            status = error.code
            response_instance_id = error.headers.get("x-fullmag-api-instance")
        if len(raw) > HTTP_BODY_LIMIT_BYTES:
            raise RuntimeError(f"HTTP response exceeded {HTTP_BODY_LIMIT_BYTES} bytes")
        result = json.loads(raw.decode("utf-8")) if raw else None
        record.update(status=status, response=result, api_instance_id=response_instance_id)
        if expected_instance_id is not None and response_instance_id != expected_instance_id:
            raise RuntimeError("HTTP response has a different API instance pin")
        return status, result
    except Exception as error:
        record["transport_error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        evidence["http"].append(record)
        _persist_evidence(evidence_path, evidence)


def _check(name: str, condition: bool, evidence: dict,
           evidence_path: Path, receipt: dict, detail: object = None) -> None:
    if not condition:
        raise AssertionError(f"{name} failed: {detail!r}")
    evidence["checks"].append(name)
    receipt["checks"].append("compute-cancellation-" + name)
    _persist_evidence(evidence_path, evidence)


def _task(snapshot: dict, task_id: str) -> dict:
    tasks = snapshot.get("tasks")
    if not isinstance(tasks, list):
        raise AssertionError(f"run summary omitted task catalog: {snapshot!r}")
    matches = [item for item in tasks if item.get("task_id") == task_id]
    if len(matches) != 1:
        raise AssertionError(f"expected one task {task_id!r}, found {len(matches)}")
    return matches[0]


def _assert_unclaimed(task: dict) -> None:
    if task.get("lifecycle") not in {"accepted", "queued"}:
        raise AssertionError(f"fixture task left its unclaimed lifecycle: {task!r}")
    for field in ("attempt_id", "ownership_epoch", "resource_id", "observation"):
        if task.get(field) is not None:
            raise AssertionError(f"unclaimed task has fabricated {field}: {task!r}")


def _api_environment(repo: Path, run_root: Path, native: dict,
                     port: int, scope: str) -> dict[str, str]:
    environment = {
        key: os.environ[key]
        for key in (
            "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMPUTERNAME"
        )
        if key in os.environ
    }
    manifest_path = Path(native["build_root"]) / "windows-runtime/build-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    checks = storage.resolve_layout(repo, "development-backend-api-checks")
    # This diagnostic status path is separate from the native workspace watcher.
    # Initialization validates its parent; no watcher file is created or modified.
    status_path = Path(checks["build_root"]) / "backend-watch-status.json"
    environment.update(
        FULLMAG_NATIVE_RUNTIME_ACTIVE="1",
        FULLMAG_DEVELOPMENT_BACKEND_GENERATION=uuid.uuid4().hex,
        FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE=str(status_path),
        FULLMAG_DEVELOPMENT_BACKEND_SOURCE=manifest["backend_source_sha256"],
        FULLMAG_DEVELOPMENT_BACKEND_VERSION=manifest["build_version"]["product_version"],
        FULLMAG_REPO_ROOT=str(repo),
        FULLMAG_STATE_ROOT=str(run_root / "compute-cancellation-api-state"),
        FULLMAG_API_PORT=str(port),
        FULLMAG_DISABLE_STATIC_CONTROL_ROOM="1",
        FULLMAG_PYTHON=str(Path(native["build_root"]) / "python/fullmag/Scripts/python.exe"),
        FULLMAG_STORAGE_PROFILE="windows-native-fdm-cpu-dev",
        FULLMAG_PROJECT_STORAGE_ROOT=str(native["storage_root"]),
        FULLMAG_WORKTREE_ID=str(native["worktree_id"]),
        FULLMAG_RUNS_ROOT=str(native["runs_root"]),
        FULLMAG_ACCEPTED_STORE_SCOPE=scope,
    )
    return environment


def _run_store_initializer(executable: Path, repo: Path, environment: dict[str, str],
                           run_root: Path, receipt: dict) -> None:
    log_path = run_root / "compute-cancellation-store-init.log"
    record = {"label": "compute-cancellation-store-initialize", "waited": False}
    with log_path.open("wb") as log:
        child = subprocess.Popen(
            [str(executable), "runtime", "initialize-scoped-accepted-store"],
            cwd=repo,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        record["pid"] = child.pid
        receipt["processes"].append(record)
        try:
            record["exit_code"] = child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            record["stop_requested_by_verifier"] = True
            child.terminate()
            try:
                record["exit_code"] = child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                record["exit_code"] = child.wait(timeout=5)
                record["forced_exit_of_owned_child"] = True
        record["waited"] = child.poll() is not None
    record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
    if record["exit_code"] != 0 or not record["waited"]:
        raise RuntimeError(f"Scoped accepted-store initializer failed: {record!r}")


def _start_writer_lock_holder(store_root: Path, marker_path: Path,
                              receipt: dict, run_root: Path) -> subprocess.Popen:
    lock_path = store_root / "WRITER.lock"
    if not lock_path.exists():
        with lock_path.open("xb") as stream:
            stream.write(WRITER_LOCK_DESCRIPTOR)
            stream.flush()
            os.fsync(stream.fileno())
    elif lock_path.read_bytes() != WRITER_LOCK_DESCRIPTOR:
        raise RuntimeError("Session writer lock descriptor has unexpected contents")

    if os.path.lexists(marker_path):
        raise RuntimeError("Writer-lock readiness marker already exists")

    helper = r'''
import json, msvcrt, os, sys
lock_path, ready_path = sys.argv[1:3]
try:
    with open(lock_path, "r+b", buffering=0) as stream:
        if stream.read() != b"fullmag.writer.lock.v1\n":
            raise RuntimeError("unexpected session writer lock descriptor")
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        marker_tmp = ready_path + ".tmp"
        with open(marker_tmp, "x", encoding="utf-8") as marker:
            json.dump({"pid": os.getpid(), "lock_path": lock_path}, marker)
            marker.flush()
            os.fsync(marker.fileno())
        if os.path.lexists(ready_path):
            raise RuntimeError("writer readiness marker already exists")
        os.replace(marker_tmp, ready_path)
        print("locked", flush=True)
        if sys.stdin.readline().strip() != "release":
            raise RuntimeError("writer lock holder did not receive its release token")
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        print("released", flush=True)
except BaseException as error:
    print(type(error).__name__ + ": " + str(error), file=sys.stderr, flush=True)
    raise
'''
    child = subprocess.Popen(
        [sys.executable, "-c", helper, str(lock_path), str(marker_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    record = {
        "label": "compute-cancellation-native-writer-lock-holder",
        "pid": child.pid,
        "waited": False,
    }
    receipt["processes"].append(record)
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if os.path.lexists(marker_path):
                marker = json.loads(marker_path.read_text(encoding="utf-8"))
                if marker.get("pid") != child.pid:
                    raise RuntimeError("Writer-lock marker belongs to another process")
                record["lock_path"] = str(lock_path)
                record["ready_marker"] = str(marker_path)
                return child
            if child.poll() is not None:
                output, errors = child.communicate(timeout=1)
                record.update(waited=True, exit_code=child.returncode)
                (run_root / "compute-cancellation-writer-holder.log").write_text(
                    output + errors, encoding="utf-8"
                )
                record["log_sha256"] = hashlib.sha256(
                    (run_root / "compute-cancellation-writer-holder.log").read_bytes()
                ).hexdigest()
                raise RuntimeError(f"Native writer-lock holder failed: {output} {errors}")
            time.sleep(0.05)
    except BaseException:
        if child.poll() is None:
            try:
                _release_writer_lock_holder(child, record, run_root)
            except Exception as cleanup_error:
                record["cleanup_error"] = f"{type(cleanup_error).__name__}: {cleanup_error}"
        raise

    _release_writer_lock_holder(child, record, run_root)
    raise TimeoutError("Native writer-lock holder did not acquire WRITER.lock")


def _release_writer_lock_holder(child: subprocess.Popen, record: dict,
                                run_root: Path) -> None:
    if child.poll() is None and child.stdin is not None:
        child.stdin.write("release\n")
        child.stdin.flush()
    try:
        output, errors = child.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        record["stop_requested_by_verifier"] = True
        child.terminate()
        try:
            output, errors = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            output, errors = child.communicate(timeout=5)
            record["forced_exit_of_owned_child"] = True
    record.update(waited=child.poll() is not None, exit_code=child.returncode)
    log_path = run_root / "compute-cancellation-writer-holder.log"
    log_path.write_text(output + errors, encoding="utf-8")
    record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
    if record["exit_code"] != 0 or not record["waited"]:
        raise RuntimeError(f"Native writer-lock holder did not release cleanly: {record!r}")


def exercise(api: Path, repo: Path, run_root: Path, receipt: dict) -> None:
    """Prove the production HTTP pre-claim request/replay/conflict contract."""
    fixture_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    evidence_path = run_root / "compute-cancellation-http-evidence.json"
    evidence = {
        "schema": "fullmag.compute-cancellation-http-evidence.v1",
        "state": "running",
        "fixture_sha256": fixture_sha256,
        "fixture_seeded": False,
        "qualification": (
            "production API durable pre-claim HTTP request/replay/conflict proof; "
            "no Submit request, worker claim, solver execution, terminal cancellation, "
            "resource-release, physics, or release qualification"
        ),
        "http": [],
        "checks": [],
    }
    _persist_evidence(evidence_path, evidence)
    child: subprocess.Popen | None = None
    lock_holder: subprocess.Popen | None = None
    lock_record: dict | None = None
    process_record: dict | None = None
    api_log_path = run_root / "compute-cancellation-api.log"
    try:
        native = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
        scope = str(uuid.uuid4())
        store_root = Path(native["runs_root"]) / "workspaces" / scope / "session-store"
        if os.path.lexists(store_root.parent):
            raise RuntimeError("Unique accepted-store scope already exists")
        state_root = run_root / "compute-cancellation-api-state"
        state_root.mkdir(parents=True, exist_ok=False)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        environment = _api_environment(repo, run_root, native, port, scope)
        store_initializer = api.parent / "fullmag.exe"
        if not store_initializer.is_file():
            raise RuntimeError("Verified native fixture package lacks fullmag.exe")

        _run_store_initializer(store_initializer, repo, environment, run_root, receipt)
        if not store_root.is_dir() or not (store_root / "objects").is_dir():
            raise RuntimeError("Scoped accepted store was not initialized by the native CLI")

        run_id = "run-cancel-http-001"
        project_id = "project-cancel-http"
        task_ids = (
            "task-cancel-http-primary",
            "task-cancel-http-stale",
            "task-cancel-http-legacy",
            "task-cancel-http-queued",
        )
        specification = {
            "schema_version": "run_spec.v2",
            "run_id": run_id,
            "snapshot": {
                "project_id": project_id,
                "definition_revision": 7,
                "definition_sha256": "a" * 64,
            },
            "study": {
                "study_id": "study-cancel-http",
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
        run_directory = store_root / "runs" / run_id
        run_directory.mkdir(parents=True, exist_ok=False)
        intent = {
            "schema_version": "run_intent.v1",
            "run_id": run_id,
            "idempotency_key": "fixture-cancel-http-001",
            "payload_sha256": _canonical_json_sha256(specification),
            "accepted_at": _utc_now(),
            "specification": specification,
        }
        catalog = {
            "schema_version": "run_catalog.v1",
            "run_id": run_id,
            "revision": 1,
            "updated_at": _utc_now(),
            "tasks": [
                {
                    "task_id": task_id,
                    "input_fingerprint": hashlib.sha256(task_id.encode("ascii")).hexdigest(),
                    "lifecycle": "queued" if task_id == task_ids[3] else "accepted",
                    "readiness": {"state": "ready"} if task_id == task_ids[3] else {
                        "state": "blocked",
                        "reason": "accepted_task_awaiting_preparation",
                    },
                    "artifact_ids": [],
                }
                for task_id in task_ids
            ],
        }
        storage.atomic_json(run_directory / "run_intent.json", intent)
        storage.atomic_json(run_directory / "run_catalog.json", catalog)
        evidence.update(
            fixture_seeded=True,
            accepted_store_scope=scope,
            accepted_store_root=str(store_root),
            run_id=run_id,
            project_id=project_id,
            seeded_task_ids=list(task_ids),
            seed_state="accepted_and_queued_unclaimed_before_api_start",
            run_intent_sha256=hashlib.sha256(
                (run_directory / "run_intent.json").read_bytes()
            ).hexdigest(),
            run_catalog_sha256=hashlib.sha256(
                (run_directory / "run_catalog.json").read_bytes()
            ).hexdigest(),
        )
        _persist_evidence(evidence_path, evidence)

        with api_log_path.open("w", encoding="utf-8") as api_log:
            child = subprocess.Popen(
                [str(api)],
                cwd=repo,
                env=environment,
                stdout=api_log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            process_record = {
                "label": "compute-cancellation-owned-native-api",
                "pid": child.pid,
                "port": port,
                "waited": False,
            }
            receipt["processes"].append(process_record)
            health_path = "/v2/platform/health"
            deadline = time.monotonic() + 20
            while True:
                if child.poll() is not None:
                    raise RuntimeError(f"Owned native API exited during startup: {api_log_path}")
                try:
                    health_request = urllib.request.Request(
                        f"http://127.0.0.1:{port}{health_path}"
                    )
                    with urllib.request.urlopen(
                        health_request, timeout=HTTP_TIMEOUT_SECONDS
                    ) as response:
                        instance_id = response.headers.get("x-fullmag-api-instance")
                        if response.status == 200 and _valid_api_instance_id(instance_id):
                            evidence["api_instance_id"] = instance_id
                            break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"Owned native API did not become ready: {api_log_path}"
                        )
                    time.sleep(0.1)
            status, health = _http_json(port, health_path, evidence, evidence_path)
            _check(
                "owned-api-ready",
                status == 200 and _valid_platform_health(health)
                and _valid_api_instance_id(evidence.get("api_instance_id")),
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": health},
            )
            process_record["api_instance_id"] = evidence["api_instance_id"]

            base = f"/v2/persistence/projects/{project_id}/runs/{run_id}"
            status, before = _http_json(port, base, evidence, evidence_path)
            _check(
                "seeded-run-intent-visible-before-cancellation",
                status == 200
                and isinstance(before, dict)
                and before.get("run_id") == run_id
                and before.get("project_id") == project_id
                and before.get("payload_fingerprint") == intent["payload_sha256"]
                and before.get("catalog_revision") == 1
                and before.get("requested_execution", {}).get("precision") == "double"
                and before.get("requested_execution", {}).get("mode") == "strict",
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": before},
            )
            for task_id in task_ids:
                _assert_unclaimed(_task(before, task_id))
            _check(
                "seeded-tasks-have-no-attempt-or-owner",
                True,
                evidence,
                evidence_path,
                receipt,
                list(task_ids),
            )
            _check(
                "seeded-tasks-have-no-prior-cancellation-intent",
                all(_task(before, task_id).get("cancellation_intent") is None for task_id in task_ids),
                evidence,
                evidence_path,
                receipt,
                {"run_id": run_id, "task_ids": list(task_ids)},
            )

            first_id = "cancel-http-primary-001"
            first_reason = "fixture requests pre-claim cancellation"
            first_request = {
                "reason": first_reason,
                "cancellation_id": first_id,
                "expected_catalog_revision": 1,
            }
            first_path = base + "/tasks/" + task_ids[0] + "/cancellation"
            status, accepted = _http_json(
                port, first_path, evidence, evidence_path,
                method="POST", payload=first_request,
            )
            _check(
                "preclaim-cancellation-returns-requested-without-command",
                status == 202
                and isinstance(accepted, dict)
                and accepted.get("disposition") == "accepted"
                and accepted.get("cancellation_id") == first_id
                and accepted.get("cancellation_state") == "requested"
                and accepted.get("expected_catalog_revision") == 1
                and accepted.get("catalog_revision") == 2
                and accepted.get("lifecycle") == "accepted"
                and "command_id" not in accepted,
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": accepted},
            )

            status, after_first = _http_json(port, base, evidence, evidence_path)
            primary_after_first = _task(after_first, task_ids[0])
            first_summary = primary_after_first.get("cancellation_intent")
            _assert_unclaimed(primary_after_first)
            _check(
                "get-run-exposes-original-cancellation-intent",
                status == 200
                and after_first.get("catalog_revision") == 2
                and isinstance(first_summary, dict)
                and first_summary.get("cancellation_id") == first_id
                and first_summary.get("expected_catalog_revision") == 1
                and first_summary.get("reason") == first_reason
                and bool(first_summary.get("created_at")),
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": after_first},
            )
            original_created_at = first_summary["created_at"]

            status, replay = _http_json(
                port, first_path, evidence, evidence_path,
                method="POST", payload=first_request,
            )
            _check(
                "identical-retry-replays-original-request",
                status == 200
                and isinstance(replay, dict)
                and replay.get("disposition") == "replayed"
                and replay.get("cancellation_id") == first_id
                and replay.get("expected_catalog_revision") == 1
                and replay.get("catalog_revision") == 2
                and replay.get("lifecycle") == "accepted"
                and "command_id" not in replay,
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": replay},
            )
            status, after_replay = _http_json(port, base, evidence, evidence_path)
            primary_after_replay = _task(after_replay, task_ids[0])
            replay_summary = primary_after_replay.get("cancellation_intent")
            _assert_unclaimed(primary_after_replay)
            _check(
                "retry-preserves-original-cancellation-identity-revision-and-time",
                status == 200
                and after_replay.get("catalog_revision") == 2
                and isinstance(replay_summary, dict)
                and replay_summary.get("cancellation_id") == first_id
                and replay_summary.get("expected_catalog_revision") == 1
                and replay_summary.get("created_at") == original_created_at,
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": after_replay},
            )

            changed_request = {
                "reason": "fixture changes cancellation identity",
                "cancellation_id": "cancel-http-primary-changed",
                "expected_catalog_revision": 1,
            }
            status, changed = _http_json(
                port, first_path, evidence, evidence_path,
                method="POST", payload=changed_request,
            )
            _check(
                "changed-cancellation-identity-conflicts",
                status == 409
                and isinstance(changed, dict)
                and changed.get("code") == "run_task_cancel_identity_conflict",
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": changed},
            )
            status, after_changed = _http_json(port, base, evidence, evidence_path)
            primary_after_changed = _task(after_changed, task_ids[0])
            changed_summary = primary_after_changed.get("cancellation_intent")
            _assert_unclaimed(primary_after_changed)
            _check(
                "identity-conflict-keeps-original-record-and-catalog",
                status == 200
                and after_changed.get("catalog_revision") == 2
                and isinstance(changed_summary, dict)
                and changed_summary.get("cancellation_id") == first_id
                and changed_summary.get("created_at") == original_created_at,
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": after_changed},
            )

            malformed_request = {
                "reason": "fixture omits the paired catalog revision",
                "cancellation_id": "cancel-http-malformed",
            }
            malformed_path = base + "/tasks/" + task_ids[2] + "/cancellation"
            status, malformed = _http_json(
                port, malformed_path, evidence, evidence_path,
                method="POST", payload=malformed_request,
            )
            _check(
                "cancellation-id-without-revision-is-bad-request",
                status == 400
                and isinstance(malformed, dict)
                and malformed.get("code") == "bad_request",
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": malformed},
            )

            stale_request = {
                "reason": "fixture uses a stale catalog revision",
                "cancellation_id": "cancel-http-stale-001",
                "expected_catalog_revision": 1,
            }
            stale_path = base + "/tasks/" + task_ids[1] + "/cancellation"
            status, stale = _http_json(
                port, stale_path, evidence, evidence_path,
                method="POST", payload=stale_request,
            )
            _check(
                "stale-catalog-revision-conflicts-specifically",
                status == 409
                and isinstance(stale, dict)
                and stale.get("code") == "run_task_cancel_revision_conflict",
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": stale},
            )

            lock_marker = run_root / "compute-cancellation-writer-lock-ready.json"
            lock_holder = _start_writer_lock_holder(
                store_root, lock_marker, receipt, run_root
            )
            lock_record = receipt["processes"][-1]
            busy_request = {
                "reason": "fixture observes an active native store writer",
                "cancellation_id": "cancel-http-busy-001",
                "expected_catalog_revision": 2,
            }
            try:
                status, busy = _http_json(
                    port, stale_path, evidence, evidence_path,
                    method="POST", payload=busy_request,
                )
            finally:
                holder_to_release = lock_holder
                lock_holder = None
                _release_writer_lock_holder(holder_to_release, lock_record, run_root)
            _check(
                "active-native-writer-returns-run-store-busy",
                status == 409
                and isinstance(busy, dict)
                and busy.get("code") == "run_store_busy",
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": busy},
            )

            legacy_request = {"reason": "fixture exercises the legacy reason-only path"}
            status, legacy = _http_json(
                port, stale_path, evidence, evidence_path,
                method="POST", payload=legacy_request,
            )
            _check(
                "legacy-reason-only-cannot-stop-an-unclaimed-task",
                status == 409
                and isinstance(legacy, dict)
                and legacy.get("code") == "run_task_cancel_rejected",
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": legacy},
            )

            queued_request = {
                "reason": "fixture cancels a ready unclaimed queued task",
                "cancellation_id": "cancel-http-queued-001",
                "expected_catalog_revision": 2,
            }
            status, queued = _http_json(
                port, base + "/tasks/" + task_ids[3] + "/cancellation", evidence, evidence_path,
                method="POST", payload=queued_request,
            )
            _check(
                "queued-task-cancellation-recorded-without-claim",
                status == 202 and isinstance(queued, dict)
                and queued.get("lifecycle") == "queued"
                and queued.get("cancellation_state") == "requested"
                and queued.get("catalog_revision") == 3
                and queued.get("cancellation_id") == queued_request["cancellation_id"]
                and "command_id" not in queued,
                evidence, evidence_path, receipt, {"status": status, "body": queued},
            )
            status, advanced_replay = _http_json(
                port, first_path, evidence, evidence_path, method="POST", payload=first_request,
            )
            _check(
                "original-request-replays-after-another-task-advances-catalog",
                status == 200 and isinstance(advanced_replay, dict)
                and advanced_replay.get("catalog_revision") == 3
                and advanced_replay.get("expected_catalog_revision") == 1
                and advanced_replay.get("cancellation_id") == first_id,
                evidence, evidence_path, receipt, {"status": status, "body": advanced_replay},
            )
            status, final = _http_json(port, base, evidence, evidence_path)
            primary_final = _task(final, task_ids[0])
            stale_final = _task(final, task_ids[1])
            legacy_final = _task(final, task_ids[2])
            _assert_unclaimed(primary_final)
            _assert_unclaimed(stale_final)
            _assert_unclaimed(legacy_final)
            _assert_unclaimed(_task(final, task_ids[3]))
            final_primary_intent = primary_final.get("cancellation_intent")
            _check(
                "rejected-requests-add-no-record-or-fabricated-claim",
                status == 200
                and final.get("catalog_revision") == 3
                and isinstance(final_primary_intent, dict)
                and final_primary_intent.get("cancellation_id") == first_id
                and final_primary_intent.get("created_at") == original_created_at
                and stale_final.get("cancellation_intent") is None
                and legacy_final.get("cancellation_intent") is None,
                evidence,
                evidence_path,
                receipt,
                {"status": status, "body": final},
            )
            _check(
                "fixture-source-remained-unchanged",
                hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == fixture_sha256,
                evidence,
                evidence_path,
                receipt,
                fixture_sha256,
            )

            receipt["compute_cancellation_fixture_seeded"] = True
            receipt["compute_cancellation_fixture_sha256"] = fixture_sha256
            receipt["compute_cancellation_store_scope"] = scope
            receipt["compute_cancellation_run_id"] = run_id
            receipt["compute_cancellation_evidence"] = str(evidence_path)
            receipt["compute_cancellation_store_root"] = str(store_root)
            receipt["compute_cancellation_qualification"] = evidence["qualification"]
    except Exception as error:
        evidence["state"] = "failed"
        evidence["failure"] = f"{type(error).__name__}: {error}"
        _persist_evidence(evidence_path, evidence)
        raise
    finally:
        try:
            if lock_holder is not None and lock_record is not None:
                _release_writer_lock_holder(lock_holder, lock_record, run_root)
        finally:
            try:
                if child is not None and process_record is not None:
                    if child.poll() is None:
                        process_record["stop_requested_by_verifier"] = True
                        child.terminate()
                    try:
                        process_record["exit_code"] = child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        process_record["exit_code"] = child.wait(timeout=5)
                        process_record["forced_exit_of_owned_child"] = True
                    process_record.update(waited=child.poll() is not None)
                    process_record["log_sha256"] = hashlib.sha256(api_log_path.read_bytes()).hexdigest()
                if evidence["state"] != "failed":
                    evidence["state"] = "completed"
            finally:
                _persist_evidence(evidence_path, evidence)
