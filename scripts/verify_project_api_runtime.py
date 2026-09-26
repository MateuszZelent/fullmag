#!/usr/bin/env python3
"""Run a managed, runtime-free project API smoke with bound source identity.

The route builds the API with the exact source snapshot captured immediately
before the build, starts it on an isolated loopback port, and exercises only
health, build identity, project New/Open, session-scoped recovery rejection, and a
controlled process restart followed by a bytes-only project reopen.  It never
creates a filesystem project target, restores a runtime session, or invokes a
solver.  The receipt is kept under the resolver-owned build storage so the
result can be reviewed without treating a local process as a release
qualification.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as source_identity  # noqa: E402
import fullmag_storage as storage  # noqa: E402
from verify_session_persistence import toolchain_identity  # noqa: E402


PROJECT_API_PROFILE = "windows-project-api-runtime"
PROJECT_REALTIME_PROFILE = "windows-project-realtime-runtime"
RECEIPT_SCHEMA = "fullmag_project_api_runtime_v1"
RUN_ID_RE = uuid.UUID


class ApiRuntimeSmokeError(RuntimeError):
    """A preflight, build, process, or HTTP contract failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_atomic_json(path: Path, value: object) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def json_request(
    url: str,
    *,
    method: str = "GET",
    payload: object | None = None,
    timeout: float = 10.0,
    expected_error: int | None = None,
) -> tuple[int, object]:
    body = None
    headers = {"accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        if error.code == expected_error:
            return error.code, json.loads(detail)
        raise ApiRuntimeSmokeError(
            f"HTTP {error.code} for {method} {url}: {detail[:500]}"
        ) from error
    except urllib.error.URLError as error:
        raise ApiRuntimeSmokeError(f"request failed for {method} {url}: {error}") from error


def runtime_free_recovery(base_url: str) -> dict:
    status, payload = json_request(
        f"{base_url}/v2/sessions/current/persistence/recovery", expected_error=404
    )
    if status != 404 or not isinstance(payload, dict) or payload.get("code") != "not_found":
        raise ApiRuntimeSmokeError("recovery must reject a request without an active session")
    return {"status": status, "code": payload["code"]}


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def contained_run_paths(layout: dict[str, str], run_id: str) -> dict[str, Path]:
    build_storage = Path(layout["build_storage_root"])
    run_root = storage.validate_path(
        Path(layout["build_root"]) / "project-api-runtime" / run_id,
        build_storage,
        "project API runtime run root",
    )
    temp_root = storage.validate_path(
        Path(layout["temp_root"]) / "project-api-runtime" / run_id,
        build_storage,
        "project API runtime temporary root",
    )
    return {
        "run_root": run_root,
        "temp_root": temp_root,
        "state_root": storage.validate_path(
            run_root / "state", build_storage, "project API state root"
        ),
        "target_dir": storage.validate_path(
            Path(layout["build_root"]) / "cargo-target", build_storage, "project API cargo target"
        ),
        "cargo_home": storage.validate_path(
            Path(layout["cache_root"]) / "cargo",
            Path(layout["cache_root"]),
            "project API Cargo home",
        ),
        "rustup_home": storage.validate_path(
            Path(layout["cache_root"]) / "rustup",
            Path(layout["cache_root"]),
            "project API Rustup home",
        ),
        "receipt": storage.validate_path(
            run_root / "receipt.json", build_storage, "project API receipt"
        ),
        "cargo_log": storage.validate_path(
            run_root / "cargo.log", build_storage, "project API Cargo log"
        ),
        "server_log": storage.validate_path(
            run_root / "server.log", build_storage, "project API server log"
        ),
        "server_log_reconnect": storage.validate_path(
            run_root / "server-reconnect.log",
            build_storage,
            "project API reconnect server log",
        ),
        "realtime_ws_log": storage.validate_path(
            run_root / "realtime-ws.log",
            build_storage,
            "project API realtime websocket log",
        ),
        "source_snapshot": storage.validate_path(
            run_root / "source-snapshot.v2.json",
            build_storage,
            "project API source snapshot",
        ),
        "source_snapshot_after": storage.validate_path(
            run_root / "source-snapshot-after.v2.json",
            build_storage,
            "project API post-run source snapshot",
        ),
    }


def child_environment(
    layout: dict[str, object],
    paths: dict[str, Path],
    tools: dict[str, Path],
    profile: str,
) -> dict[str, str]:
    env = {str(key): str(value) for key, value in os.environ.items()}
    env.update({str(key): str(value) for key, value in layout["env"].items()})
    env.update(
        {
            "FULLMAG_STORAGE_PROFILE": profile,
            "CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_ROOT": str(paths["target_dir"]),
            "CARGO_HOME": str(paths["cargo_home"]),
            "RUSTUP_HOME": str(paths["rustup_home"]),
            "RUSTC": str(tools["rustc"]),
            "FULLMAG_STATE_ROOT": str(paths["state_root"]),
            # Keep the managed API smoke deterministic on constrained Windows
            # hosts; the route is an evidence gate, not a throughput benchmark.
            "CARGO_BUILD_JOBS": "1",
            "TMPDIR": str(paths["temp_root"]),
            "TEMP": str(paths["temp_root"]),
            "TMP": str(paths["temp_root"]),
        }
    )
    bins: list[str] = []
    for tool in (tools["cargo"], tools["rustc"]):
        parent = str(Path(tool).parent)
        if parent not in bins:
            bins.append(parent)
    old_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(bins + ([old_path] if old_path else []))
    env.pop("RUSTUP_TOOLCHAIN", None)
    return env


def run_realtime_websocket_probe(
    repo_root: Path,
    base_url: str,
    paths: dict[str, Path],
    env: dict[str, str],
) -> dict[str, object]:
    node = shutil.which("node", path=env.get("PATH"))
    if not node:
        raise ApiRuntimeSmokeError("node is required for the managed realtime websocket probe")
    probe = SCRIPT_DIR / "probe_realtime_ws.mjs"
    if not probe.is_file():
        raise ApiRuntimeSmokeError(f"realtime websocket probe is missing: {probe}")
    websocket_url = base_url.replace("http://", "ws://", 1) + "/v2/sessions/current/events/ws"
    result = subprocess.run(
        [node, str(probe), websocket_url],
        cwd=repo_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    paths["realtime_ws_log"].write_text(
        f"$ {node} {probe} {websocket_url}\n"
        f"exit_code={result.returncode}\n"
        f"stdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}\n",
        encoding="utf-8",
        newline="\n",
    )
    if result.returncode != 0:
        raise ApiRuntimeSmokeError(
            f"managed realtime websocket probe failed with code {result.returncode}: "
            f"{result.stderr.strip()[-500:]}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ApiRuntimeSmokeError(
            f"managed realtime websocket probe did not emit JSON: {result.stdout[:500]!r}"
        ) from error
    if not isinstance(payload, dict) or payload.get("state") != "passed":
        raise ApiRuntimeSmokeError("managed realtime websocket probe returned an invalid result")
    return payload


def wait_for_health(base_url: str, process: subprocess.Popen[bytes]) -> dict[str, object]:
    deadline = time.monotonic() + 30.0
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ApiRuntimeSmokeError(
                f"fullmag-api exited before health check with code {process.returncode}"
            )
        try:
            status, payload = json_request(f"{base_url}/healthz", timeout=2.0)
            if status == 200 and isinstance(payload, dict) and payload.get("status") == "ok":
                return payload
        except Exception as error:  # retry until the bounded readiness deadline
            last_error = error
        time.sleep(0.25)
    raise ApiRuntimeSmokeError(f"fullmag-api health timeout: {last_error}")


def terminate_process(process: subprocess.Popen[bytes]) -> int | None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    return process.returncode


def assert_build_identity(
    payload: object, expected_identity: dict[str, object]
) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ApiRuntimeSmokeError("OpenAPI response is not an object")
    build_identity = payload.get("x-fullmag-build-identity")
    if not isinstance(build_identity, dict):
        raise ApiRuntimeSmokeError("OpenAPI is missing x-fullmag-build-identity")
    for key, expected in expected_identity.items():
        if key == "built_at_utc":
            continue
        if build_identity.get(key) != expected:
            raise ApiRuntimeSmokeError(
                f"build identity mismatch for {key}: "
                f"{build_identity.get(key)!r} != {expected!r}"
            )
    return build_identity


def load_project_run_fixture(layout: dict[str, object]) -> tuple[dict, dict]:
    source = os.environ.get("FULLMAG_PROJECT_RUN_FIXTURE_RECEIPT")
    if not source:
        raise ApiRuntimeSmokeError("FULLMAG_PROJECT_RUN_FIXTURE_RECEIPT is required")
    receipt_path = storage.validate_path(Path(source), Path(layout["build_storage_root"]), "run fixture receipt")
    fixture_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if (fixture_receipt.get("route") != "api-project-run-tests"
            or fixture_receipt.get("state") != "passed"
            or fixture_receipt.get("source_changed_during_run") is not False):
        raise ApiRuntimeSmokeError("run fixture requires a passing source-bound HTTP receipt")
    artifact = fixture_receipt["project_run_fixture"]
    path = storage.validate_path(Path(artifact["path"]), receipt_path.parent, "run fixture payload")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != artifact["sha256"]:
        raise ApiRuntimeSmokeError("run fixture hash differs from its receipt")
    payload = json.loads(raw)
    identity = uuid.uuid4().hex
    payload["run_intent"]["idempotency_key"] = f"restart-{identity}"
    payload["run_intent"]["specification"]["run_id"] = f"run-{identity}"
    return payload, {"receipt": str(receipt_path), "sha256": artifact["sha256"]}


def probe_project_run(base_url: str, payload: dict, previous: dict | None = None) -> dict:
    intent = payload["run_intent"]
    project_id = intent["specification"]["snapshot"]["project_id"]
    run_id = intent["specification"]["run_id"]
    route = f"{base_url}/v2/persistence/projects/{project_id}/runs"
    run_route = f"{route}/{run_id}"
    if previous is not None:
        _, restored = json_request(run_route)
        if restored != previous["snapshot"]:
            raise ApiRuntimeSmokeError("durable run changed across API process restart")
    status, accepted = json_request(route, method="POST", payload=payload)
    if (status != (200 if previous else 201) or accepted.get("run_id") != run_id
            or accepted.get("disposition") != ("replayed" if previous else "accepted")):
        raise ApiRuntimeSmokeError("Submit did not preserve durable idempotency across restart")
    _, catalog = json_request(f"{run_route}/materialization", method="POST")
    _, snapshot = json_request(run_route)
    if (catalog.get("execution_state") != "pending_preparation"
            or not catalog.get("task_ids") or snapshot.get("catalog_state") != "materialized"):
        raise ApiRuntimeSmokeError("run was not materialized into blocked preparation tasks")
    tasks = snapshot.get("tasks", [])
    if not tasks or any(task.get("lifecycle") != "accepted"
                        or task.get("readiness", {}).get("state") != "blocked" for task in tasks):
        raise ApiRuntimeSmokeError("runtime-free probe unexpectedly advanced a task")
    if previous is not None and (catalog != previous["catalog"] or snapshot != previous["snapshot"]):
        raise ApiRuntimeSmokeError("replay changed the durable run catalog")
    return {"run_id": run_id, "catalog": catalog, "snapshot": snapshot}


def run(repo_root: Path, *, include_websocket: bool = False, include_project_run: bool = False) -> tuple[int, dict[str, object]]:
    if os.name != "nt":
        raise ApiRuntimeSmokeError("managed project API routes are supported only on Windows")

    profile = PROJECT_REALTIME_PROFILE if include_websocket else PROJECT_API_PROFILE
    layout = storage.resolve_layout(repo_root, profile)
    storage.initialize(layout)
    with storage.build_lock(layout):
        run_id = uuid.uuid4().hex
        paths = contained_run_paths(layout, run_id)
        for path in (
            paths["run_root"],
            paths["temp_root"],
            paths["target_dir"],
            paths["cargo_home"],
            paths["rustup_home"],
            paths["state_root"],
        ):
            path.mkdir(parents=True, exist_ok=True)

        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "route": "project-api-runtime",
            "profile": profile,
            "run_id": run_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": layout["repo_root"],
            "started_at": utc_now(),
            "state": "preflight",
            "paths": {key: str(value) for key, value in paths.items()},
            "build_command": ["cargo", "build", "--locked", "--offline", "-p", "fullmag-api"],
            "runtime_scope": [
                "GET /healthz",
                "GET /v2/platform/openapi.json",
                "POST /v2/persistence/projects",
                "POST /v2/persistence/projects/open",
                "GET /v2/sessions/current/persistence/recovery",
                "process termination and restart with bytes-only project reopen",
            ],
            "runtime_mutations": [],
        }
        write_atomic_json(paths["receipt"], receipt)
        process: subprocess.Popen[bytes] | None = None
        process_exit_codes: list[int | None] = []
        return_code = 2
        try:
            run_payload = None
            if include_project_run:
                run_payload, fixture_evidence = load_project_run_fixture(layout)
                receipt["project_run_fixture"] = fixture_evidence
                receipt["runtime_scope"].append("durable Submit/materialization/replay across process restart")
                receipt["runtime_mutations"].append("synthetic durable run and blocked task catalog; no worker")
            identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot"], identity)
            receipt["source_identity"] = identity
            toolchain, tools = toolchain_identity()
            receipt["toolchain"] = toolchain
            env = child_environment(layout, paths, tools, profile)
            env.update(
                {
                    "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
                    "FULLMAG_SOURCE_WORKTREE_STATE": "dirty"
                    if identity["source_snapshot_dirty"]
                    else "clean",
                    "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(identity["source_snapshot_sha256"]),
                    "FULLMAG_DISABLE_STATIC_CONTROL_ROOM": "1",
                }
            )
            port = free_loopback_port()
            env["FULLMAG_API_PORT"] = str(port)
            receipt["api_port"] = port
            paths["cargo_log"].parent.mkdir(parents=True, exist_ok=True)
            with paths["cargo_log"].open("w", encoding="utf-8", newline="\n") as cargo_log:
                receipt["state"] = "building"
                write_atomic_json(paths["receipt"], receipt)
                cargo = str(tools["cargo"])
                build = subprocess.run(
                    [cargo, "build", "--locked", "--offline", "-p", "fullmag-api"],
                    cwd=repo_root,
                    env=env,
                    stdout=cargo_log,
                    stderr=subprocess.STDOUT,
                    text=True,
                    check=False,
                )
            receipt["build_exit_code"] = build.returncode
            if build.returncode != 0:
                raise ApiRuntimeSmokeError(f"fullmag-api build failed with code {build.returncode}")

            binary_name = "fullmag-api.exe" if os.name == "nt" else "fullmag-api"
            binary = paths["target_dir"] / "debug" / binary_name
            if not binary.is_file() or binary.stat().st_size == 0:
                raise ApiRuntimeSmokeError(f"fullmag-api binary is missing or empty: {binary}")
            preserved_binary = paths["run_root"] / binary_name
            shutil.copy2(binary, preserved_binary)
            binary = preserved_binary
            receipt["binary"] = str(binary)
            receipt["binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
            receipt["state"] = "running"
            write_atomic_json(paths["receipt"], receipt)
            with paths["server_log"].open("w", encoding="utf-8", newline="\n") as server_log:
                process = subprocess.Popen(
                    [str(binary)],
                    cwd=repo_root,
                    env=env,
                    stdout=server_log,
                    stderr=subprocess.STDOUT,
                )
                base_url = f"http://127.0.0.1:{port}"
                health = wait_for_health(base_url, process)
                _, openapi = json_request(f"{base_url}/v2/platform/openapi.json")
                if not isinstance(openapi, dict):
                    raise ApiRuntimeSmokeError("OpenAPI response is not an object")
                build_identity = openapi.get("x-fullmag-build-identity")
                if build_identity != {
                    "built_at_utc": build_identity.get("built_at_utc") if isinstance(build_identity, dict) else None,
                    "git_commit": identity["head_commit_full"],
                    "source_snapshot_sha256": identity["source_snapshot_sha256"],
                    "worktree_state": "dirty" if identity["source_snapshot_dirty"] else "clean",
                }:
                    if not isinstance(build_identity, dict):
                        raise ApiRuntimeSmokeError("OpenAPI is missing x-fullmag-build-identity")
                    for key, expected in (
                        ("git_commit", identity["head_commit_full"]),
                        ("source_snapshot_sha256", identity["source_snapshot_sha256"]),
                        ("worktree_state", "dirty" if identity["source_snapshot_dirty"] else "clean"),
                    ):
                        if build_identity.get(key) != expected:
                            raise ApiRuntimeSmokeError(
                                f"build identity mismatch for {key}: {build_identity.get(key)!r} != {expected!r}"
                            )
                _, created = json_request(
                    f"{base_url}/v2/persistence/projects",
                    method="POST",
                    payload={"name": "managed-p1-runtime"},
                )
                if not isinstance(created, dict):
                    raise ApiRuntimeSmokeError("create response is not an object")
                if (
                    created.get("mode", {}).get("kind") != "read_write"
                    or created.get("durability") != "memory_only"
                    or created.get("dirty") is not True
                ):
                    raise ApiRuntimeSmokeError("create project contract mismatch")
                archive_base64 = created.get("archive_base64")
                if not isinstance(archive_base64, str) or not archive_base64:
                    raise ApiRuntimeSmokeError("create response omitted archive bytes")
                archive_bytes = base64.b64decode(archive_base64, validate=True)
                _, opened = json_request(
                    f"{base_url}/v2/persistence/projects/open",
                    method="POST",
                    payload={
                        "display_name": "managed-p1-runtime.fms",
                        "archive_base64": archive_base64,
                    },
                )
                if not isinstance(opened, dict):
                    raise ApiRuntimeSmokeError("open response is not an object")
                if (
                    opened.get("project_id") != created.get("project_id")
                    or opened.get("revision") != 0
                    or opened.get("dirty") is not False
                    or opened.get("mode", {}).get("kind") != "read_write"
                ):
                    raise ApiRuntimeSmokeError("open project contract mismatch")
                recovery = runtime_free_recovery(base_url)
                if include_websocket:
                    _, scratch_session = json_request(
                        f"{base_url}/v2/sessions",
                        method="POST",
                        payload={
                            "name": "managed-p1-realtime",
                            "backend": "fdm",
                            "device": "cpu",
                            "precision": "double",
                            "replace_current": True,
                        },
                    )
                    if not isinstance(scratch_session, dict) or not scratch_session.get("session_id"):
                        raise ApiRuntimeSmokeError("scratch session creation returned no session_id")
                    receipt["runtime_scope"].append("POST /v2/sessions (empty scratch session only)")
                    receipt["runtime_mutations"] = [
                        "empty scratch session created for transport smoke; no solver or runtime restore"
                    ]
                    receipt["realtime_websocket"] = run_realtime_websocket_probe(
                        repo_root, base_url, paths, env
                    )
                    receipt["scratch_session"] = {
                        "session_id": scratch_session.get("session_id"),
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "solver_started": False,
                    }
                if run_payload is not None:
                    run_before_restart = probe_project_run(base_url, run_payload)
                    receipt["project_run_before_restart"] = run_before_restart
                first_exit = terminate_process(process)
                process_exit_codes.append(first_exit)
                process = None

            reconnect_port = free_loopback_port()
            reconnect_env = dict(env)
            reconnect_env["FULLMAG_API_PORT"] = str(reconnect_port)
            receipt["reconnect_api_port"] = reconnect_port
            with paths["server_log_reconnect"].open(
                "w", encoding="utf-8", newline="\n"
            ) as reconnect_log:
                process = subprocess.Popen(
                    [str(binary)],
                    cwd=repo_root,
                    env=reconnect_env,
                    stdout=reconnect_log,
                    stderr=subprocess.STDOUT,
                )
                reconnect_base_url = f"http://127.0.0.1:{reconnect_port}"
                reconnect_health = wait_for_health(reconnect_base_url, process)
                _, reconnect_openapi = json_request(
                    f"{reconnect_base_url}/v2/platform/openapi.json"
                )
                reconnect_build_identity = assert_build_identity(
                    reconnect_openapi,
                    {
                        "git_commit": identity["head_commit_full"],
                        "source_snapshot_sha256": identity["source_snapshot_sha256"],
                        "worktree_state": "dirty"
                        if identity["source_snapshot_dirty"]
                        else "clean",
                    },
                )
                _, reopened_after_disconnect = json_request(
                    f"{reconnect_base_url}/v2/persistence/projects/open",
                    method="POST",
                    payload={
                        "display_name": "managed-p1-reconnect.fms",
                        "archive_base64": archive_base64,
                    },
                )
                if not isinstance(reopened_after_disconnect, dict):
                    raise ApiRuntimeSmokeError(
                        "reconnect open response is not an object"
                    )
                if (
                    reopened_after_disconnect.get("project_id")
                    != created.get("project_id")
                    or reopened_after_disconnect.get("revision") != 0
                    or reopened_after_disconnect.get("dirty") is not False
                    or reopened_after_disconnect.get("mode", {}).get("kind")
                    != "read_write"
                ):
                    raise ApiRuntimeSmokeError(
                        "project identity or clean state changed after API reconnect"
                    )
                reconnect_recovery = runtime_free_recovery(reconnect_base_url)
                if run_payload is not None:
                    receipt["project_run_after_restart"] = probe_project_run(
                        reconnect_base_url, run_payload, run_before_restart
                    )
                second_exit = terminate_process(process)
                process_exit_codes.append(second_exit)
                process = None

            receipt["health"] = health
            receipt["build_identity"] = build_identity
            receipt["project"] = {
                "create_project_id": created.get("project_id"),
                "open_project_id": opened.get("project_id"),
                "reconnect_open_project_id": reopened_after_disconnect.get("project_id"),
                "create_revision": created.get("revision"),
                "open_revision": opened.get("revision"),
                "reconnect_open_revision": reopened_after_disconnect.get("revision"),
                "create_dirty": created.get("dirty"),
                "open_dirty": opened.get("dirty"),
                "reconnect_open_dirty": reopened_after_disconnect.get("dirty"),
                "archive_bytes": len(archive_bytes),
            }
            receipt["recovery"] = recovery
            receipt["reconnect"] = {
                "health": reconnect_health,
                "build_identity": reconnect_build_identity,
                "recovery": reconnect_recovery,
                "same_project_id": reopened_after_disconnect.get("project_id")
                == created.get("project_id"),
                "runtime_mutations": [],
            }
            receipt["server_exit_codes"] = process_exit_codes
            source_after = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot_after"], source_after)
            receipt["source_identity_after"] = source_after
            changed = source_after["source_snapshot_sha256"] != identity["source_snapshot_sha256"]
            receipt["source_changed_during_run"] = changed
            if changed:
                raise ApiRuntimeSmokeError("source identity changed during API runtime smoke")
            receipt["state"] = "passed"
            return_code = 0
        except BaseException as error:
            receipt["state"] = "failed"
            receipt["error"] = f"{type(error).__name__}: {error}"
            return_code = 1
        finally:
            if process is not None:
                receipt["server_exit_code"] = terminate_process(process)
            receipt["finished_at"] = utc_now()
            receipt["exit_code"] = return_code
            write_atomic_json(paths["receipt"], receipt)
        print(json.dumps({"receipt": str(paths["receipt"]), "state": receipt["state"],
                          "error": receipt.get("error")}, ensure_ascii=False))
        return return_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument(
        "--include-websocket",
        action="store_true",
        help="also create an empty scratch session and verify the managed realtime handshake/reconnect",
    )
    parser.add_argument("--include-project-run", action="store_true",
                        help="verify durable Submit and materialization across process restart")
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve(), include_websocket=args.include_websocket,
                   include_project_run=args.include_project_run)[0]
    except Exception as error:
        print(f"project API runtime smoke failed before receipt: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
